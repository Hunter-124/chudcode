#include "vcs/diff_model.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <iomanip>
#include <limits>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace chud::vcs {
namespace {

constexpr float kMotionSeconds = 0.18F;

std::vector<std::string_view> splitLines(std::string_view text) {
    std::vector<std::string_view> result;
    std::size_t start = 0;
    while (start < text.size()) {
        const std::size_t end = text.find('\n', start);
        std::string_view line = text.substr(start, end == std::string_view::npos ? text.size() - start
                                                                                : end - start);
        if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
        result.push_back(line);
        if (end == std::string_view::npos) return result;
        start = end + 1;
    }
    return result;
}

bool startsWith(std::string_view value, std::string_view prefix) {
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

std::string decodeGitPath(std::string_view token) {
    while (!token.empty() && (token.back() == '\r' || token.back() == '\n')) token.remove_suffix(1);
    if (token.size() < 2 || token.front() != '"' || token.back() != '"') return std::string(token);

    std::string out;
    out.reserve(token.size() - 2);
    for (std::size_t i = 1; i + 1 < token.size(); ++i) {
        char c = token[i];
        if (c != '\\' || i + 1 >= token.size() - 1) {
            out.push_back(c);
            continue;
        }
        c = token[++i];
        switch (c) {
        case 'a': out.push_back('\a'); break;
        case 'b': out.push_back('\b'); break;
        case 't': out.push_back('\t'); break;
        case 'n': out.push_back('\n'); break;
        case 'v': out.push_back('\v'); break;
        case 'f': out.push_back('\f'); break;
        case 'r': out.push_back('\r'); break;
        case '\\': out.push_back('\\'); break;
        case '"': out.push_back('"'); break;
        default:
            if (c >= '0' && c <= '7') {
                unsigned value = static_cast<unsigned>(c - '0');
                int digits = 1;
                while (digits < 3 && i + 1 < token.size() - 1 && token[i + 1] >= '0' &&
                       token[i + 1] <= '7') {
                    value = value * 8U + static_cast<unsigned>(token[++i] - '0');
                    ++digits;
                }
                out.push_back(static_cast<char>(value));
            } else {
                // Unknown escapes remain literal data rather than being rejected or executed.
                out.push_back(c);
            }
            break;
        }
    }
    return out;
}

std::string normalizedPath(std::string_view token, char prefix) {
    std::string path = decodeGitPath(token);
    if (path == "/dev/null") return {};
    if (path.size() > 2 && path[0] == prefix && path[1] == '/') path.erase(0, 2);
    return path;
}

std::pair<std::string, std::string> parseDiffPaths(std::string_view line) {
    std::string_view rest = line.substr(std::string_view("diff --git ").size());
    auto parseQuoted = [&](std::size_t& cursor) -> std::string {
        while (cursor < rest.size() && rest[cursor] == ' ') ++cursor;
        if (cursor >= rest.size()) return {};
        if (rest[cursor] != '"') {
            const std::size_t end = rest.find(' ', cursor);
            std::string value(rest.substr(cursor, end == std::string_view::npos ? rest.size() - cursor
                                                                               : end - cursor));
            cursor = end == std::string_view::npos ? rest.size() : end + 1;
            return value;
        }
        const std::size_t begin = cursor++;
        bool escaped = false;
        while (cursor < rest.size()) {
            const char c = rest[cursor++];
            if (c == '"' && !escaped) break;
            escaped = c == '\\' && !escaped;
            if (c != '\\') escaped = false;
        }
        return std::string(rest.substr(begin, cursor - begin));
    };

    if (!rest.empty() && rest.front() == '"') {
        std::size_t cursor = 0;
        return {normalizedPath(parseQuoted(cursor), 'a'), normalizedPath(parseQuoted(cursor), 'b')};
    }

    // With core.quotePath disabled, spaces may remain unquoted. The a/... / b/...
    // boundary is still unambiguous when split from the right.
    const std::size_t separator = rest.rfind(" b/");
    if (startsWith(rest, "a/") && separator != std::string_view::npos) {
        return {normalizedPath(rest.substr(0, separator), 'a'),
                normalizedPath(rest.substr(separator + 1), 'b')};
    }
    std::size_t cursor = 0;
    return {normalizedPath(parseQuoted(cursor), 'a'), normalizedPath(parseQuoted(cursor), 'b')};
}

bool parseNumber(std::string_view text, std::size_t& cursor, std::int64_t& value) {
    const std::size_t begin = cursor;
    while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') ++cursor;
    if (begin == cursor) return false;
    const auto parsed = std::from_chars(text.data() + begin, text.data() + cursor, value);
    return parsed.ec == std::errc{};
}

bool parseRange(std::string_view text, std::size_t& cursor, char marker, DiffRange& range) {
    if (cursor >= text.size() || text[cursor++] != marker || !parseNumber(text, cursor, range.start)) {
        return false;
    }
    range.count = 1;
    if (cursor < text.size() && text[cursor] == ',') {
        ++cursor;
        if (!parseNumber(text, cursor, range.count)) return false;
    }
    return true;
}

bool parseHunkHeader(std::string_view line, DiffRange& oldRange, DiffRange& newRange) {
    if (!startsWith(line, "@@ -")) return false;
    std::size_t cursor = 3;
    if (!parseRange(line, cursor, '-', oldRange)) return false;
    if (cursor >= line.size() || line[cursor++] != ' ') return false;
    if (!parseRange(line, cursor, '+', newRange)) return false;
    return cursor + 2 < line.size() && line.substr(cursor, 3) == " @@";
}

void finalizeFile(DiffFile& file) {
    if (file.binary) file.kind = DiffFileKind::Binary;
    else if (file.submodule) file.kind = DiffFileKind::Submodule;
    else if (file.renamed) file.kind = DiffFileKind::Renamed;
    else if (file.kind == DiffFileKind::Copied) {}
    else if (file.oldPath.empty()) file.kind = DiffFileKind::Added;
    else if (file.newPath.empty()) file.kind = DiffFileKind::Deleted;
    else if (file.modeChanged) file.kind = DiffFileKind::ModeChanged;

    const std::string key = file.oldPath + "\n" + file.newPath;
    file.id = stableDiffId("file", key);
    for (DiffHunk& hunk : file.hunks) {
        std::ostringstream hunkKey;
        hunkKey << file.id << ':' << hunk.oldRange.start << ',' << hunk.oldRange.count << ':'
                << hunk.newRange.start << ',' << hunk.newRange.count << ':' << hunk.header;
        hunk.id = stableDiffId("hunk", hunkKey.str());
        std::size_t markerOrdinal = 0;
        for (DiffLine& line : hunk.lines) {
            line.hunkId = hunk.id;
            std::ostringstream lineKey;
            lineKey << hunk.id << ':' << static_cast<int>(line.kind) << ':';
            if (line.oldLine) lineKey << *line.oldLine;
            lineKey << ':';
            if (line.newLine) lineKey << *line.newLine;
            if (!line.oldLine && !line.newLine) lineKey << ':' << markerOrdinal++;
            line.id = stableDiffId("line", lineKey.str());
        }
    }
}

std::string fingerprint(const DiffLine& line) {
    return std::to_string(static_cast<int>(line.kind)) + "\n" + line.text;
}

} // namespace

std::string_view DiffFile::displayPath() const noexcept {
    return newPath.empty() ? std::string_view(oldPath) : std::string_view(newPath);
}

std::string stableDiffId(std::string_view domain, std::string_view value) {
    // FNV-1a is deliberately fixed rather than std::hash, whose result is not a persistence contract.
    std::uint64_t hash = 14695981039346656037ULL;
    auto feed = [&](std::string_view bytes) {
        for (const unsigned char byte : bytes) {
            hash ^= byte;
            hash *= 1099511628211ULL;
        }
    };
    feed(domain);
    hash ^= 0xFFU;
    hash *= 1099511628211ULL;
    feed(value);
    std::ostringstream out;
    out << domain << '-' << std::hex << std::setw(16) << std::setfill('0') << hash;
    return out.str();
}

DiffDocument parseUnifiedDiff(std::string_view unified) {
    DiffDocument document;
    DiffFile* file = nullptr;
    DiffHunk* hunk = nullptr;
    std::int64_t oldLine = 0;
    std::int64_t newLine = 0;

    for (const std::string_view line : splitLines(unified)) {
        if (startsWith(line, "diff --git ")) {
            document.files.emplace_back();
            file = &document.files.back();
            const auto [oldPath, newPath] = parseDiffPaths(line);
            file->oldPath = oldPath;
            file->newPath = newPath;
            hunk = nullptr;
            continue;
        }
        if (file == nullptr) {
            if (!line.empty()) document.warnings.emplace_back("ignored content before first file header");
            continue;
        }

        if (startsWith(line, "@@@")) {
            document.warnings.emplace_back("combined merge hunks are read-only");
            hunk = nullptr;
            continue;
        }
        DiffRange oldRange;
        DiffRange newRange;
        if (parseHunkHeader(line, oldRange, newRange)) {
            file->hunks.push_back({{}, std::string(line), oldRange, newRange, {}});
            hunk = &file->hunks.back();
            oldLine = oldRange.start;
            newLine = newRange.start;
            continue;
        }

        if (hunk != nullptr) {
            DiffLine parsed;
            if (startsWith(line, "\\ No newline at end of file")) {
                parsed.kind = DiffLineKind::NoNewline;
                parsed.text = std::string(line);
            } else if (!line.empty() && line.front() == '+') {
                parsed.kind = DiffLineKind::Addition;
                parsed.text = std::string(line.substr(1));
                parsed.newLine = newLine++;
            } else if (!line.empty() && line.front() == '-') {
                parsed.kind = DiffLineKind::Deletion;
                parsed.text = std::string(line.substr(1));
                parsed.oldLine = oldLine++;
            } else if (!line.empty() && line.front() == ' ') {
                parsed.kind = DiffLineKind::Context;
                parsed.text = std::string(line.substr(1));
                parsed.oldLine = oldLine++;
                parsed.newLine = newLine++;
            } else {
                hunk = nullptr;
            }
            if (hunk != nullptr) {
                if (parsed.text.find("Subproject commit ") != std::string::npos) {
                    file->submodule = true;
                }
                hunk->lines.push_back(std::move(parsed));
                continue;
            }
        }

        if (startsWith(line, "--- ")) {
            file->oldPath = normalizedPath(line.substr(4), 'a');
        } else if (startsWith(line, "+++ ")) {
            file->newPath = normalizedPath(line.substr(4), 'b');
        } else if (startsWith(line, "rename from ")) {
            file->oldPath = decodeGitPath(line.substr(12));
            file->renamed = true;
        } else if (startsWith(line, "rename to ")) {
            file->newPath = decodeGitPath(line.substr(10));
            file->renamed = true;
        } else if (startsWith(line, "copy from ")) {
            file->oldPath = decodeGitPath(line.substr(10));
            file->kind = DiffFileKind::Copied;
        } else if (startsWith(line, "copy to ")) {
            file->newPath = decodeGitPath(line.substr(8));
            file->kind = DiffFileKind::Copied;
        } else if (startsWith(line, "Binary files ") || startsWith(line, "GIT binary patch")) {
            file->binary = true;
            file->metadata.emplace_back(line);
        } else if (startsWith(line, "old mode ") || startsWith(line, "new mode ")) {
            file->modeChanged = true;
            file->metadata.emplace_back(line);
        } else if (startsWith(line, "new file mode ")) {
            file->oldPath.clear();
            file->metadata.emplace_back(line);
        } else if (startsWith(line, "deleted file mode ")) {
            file->newPath.clear();
            file->metadata.emplace_back(line);
        } else if (line.find("Subproject commit ") != std::string_view::npos ||
                   startsWith(line, "Submodule ")) {
            file->submodule = true;
            file->metadata.emplace_back(line);
        } else if (!line.empty()) {
            file->metadata.emplace_back(line);
        }
    }

    for (DiffFile& value : document.files) finalizeFile(value);
    return document;
}

HunkGate gateHunkAction(const DiffFile& file, const DiffHunk& hunk, HunkAction action) {
    if (hunk.lines.empty()) return {false, "The hunk has no patch lines."};
    if (file.binary) return {false, "Binary patches can only be staged as a whole file."};
    if (file.renamed || file.kind == DiffFileKind::Copied) {
        return {false, "Rename and copy patches can only be staged as a whole file."};
    }
    if (file.modeChanged) return {false, "Mode changes can only be staged as a whole file."};
    if (file.submodule) return {false, "Submodule updates can only be staged as a whole file."};
    if (action == HunkAction::Revert && file.kind == DiffFileKind::Added) {
        return {false, "Revert the untracked or added file from the file action."};
    }
    return {true, {}};
}

void DiffAnimator::setReducedMotion(bool reduced) noexcept {
    reducedMotion_ = reduced;
    if (!reduced) return;
    lines_.erase(std::remove_if(lines_.begin(), lines_.end(), [](const AnimatedDiffLine& line) {
                     return line.motion == LineMotion::Removing;
                 }),
                 lines_.end());
    for (AnimatedDiffLine& line : lines_) {
        line.motion = LineMotion::Stable;
        line.progress = 1.0F;
    }
}

void DiffAnimator::setScrollAnchor(ScrollAnchor anchor) { anchor_ = std::move(anchor); }

std::vector<DiffLine> DiffAnimator::flatten(const DiffDocument& document) {
    std::vector<DiffLine> result;
    for (const DiffFile& file : document.files) {
        for (const DiffHunk& hunk : file.hunks) {
            result.insert(result.end(), hunk.lines.begin(), hunk.lines.end());
        }
    }
    return result;
}

void DiffAnimator::reconcile(const DiffDocument& document) {
    std::vector<DiffLine> incoming = flatten(document);
    std::unordered_set<std::string> incomingIds;
    incomingIds.reserve(incoming.size());
    for (const DiffLine& line : incoming) incomingIds.insert(line.id);
    std::unordered_map<std::string, AnimatedDiffLine> previous;
    previous.reserve(lines_.size());
    std::unordered_map<std::string, std::size_t> previousIndices;
    for (std::size_t i = 0; i < lines_.size(); ++i) {
        previous.emplace(lines_[i].line.id, lines_[i]);
        previousIndices.emplace(lines_[i].line.id, i);
    }

    std::size_t oldAnchorIndex = 0;
    if (const auto found = previousIndices.find(anchor_.lineId); found != previousIndices.end()) {
        oldAnchorIndex = found->second;
    }

    std::vector<AnimatedDiffLine> next;
    next.reserve(incoming.size() + previous.size());
    std::unordered_set<std::string> retained;
    retained.reserve(incoming.size());
    for (DiffLine& line : incoming) {
        const auto found = previous.find(line.id);
        if (found == previous.end()) {
            next.push_back({std::move(line), reducedMotion_ ? LineMotion::Stable : LineMotion::Inserting,
                            reducedMotion_ ? 1.0F : 0.0F});
        } else {
            AnimatedDiffLine animated = found->second;
            const bool changed = fingerprint(animated.line) != fingerprint(line);
            animated.line = std::move(line);
            if (changed && !reducedMotion_) {
                animated.motion = LineMotion::Changing;
                animated.progress = 0.0F;
            } else if (animated.motion == LineMotion::Removing && !reducedMotion_) {
                animated.motion = LineMotion::Inserting;
                animated.progress = 1.0F - animated.progress;
            } else if (animated.motion != LineMotion::Changing) {
                animated.motion = LineMotion::Stable;
                animated.progress = 1.0F;
            }
            next.push_back(std::move(animated));
            retained.insert(next.back().line.id);
        }
    }

    if (!reducedMotion_) {
        // Keep removed rows at their former neighborhood until their height reaches zero.
        for (std::size_t oldIndex = 0; oldIndex < lines_.size(); ++oldIndex) {
            const AnimatedDiffLine& old = lines_[oldIndex];
            if (retained.contains(old.line.id)) continue;
            AnimatedDiffLine removing = old;
            if (removing.motion != LineMotion::Removing) {
                removing.motion = LineMotion::Removing;
                removing.progress = 0.0F;
            }
            std::size_t insertAt = next.size();
            for (std::size_t following = oldIndex + 1; following < lines_.size(); ++following) {
                const auto position = std::find_if(next.begin(), next.end(), [&](const AnimatedDiffLine& row) {
                    return row.line.id == lines_[following].line.id;
                });
                if (position != next.end()) {
                    insertAt = static_cast<std::size_t>(position - next.begin());
                    break;
                }
            }
            next.insert(next.begin() + static_cast<std::ptrdiff_t>(insertAt), std::move(removing));
        }
    }

    if (!anchor_.lineId.empty() && !incomingIds.contains(anchor_.lineId)) {
        if (incoming.empty()) {
            anchor_.lineId.clear();
        } else {
            const std::size_t index = std::min(oldAnchorIndex, next.size() - 1);
            const auto replacement = std::find_if(
                next.begin() + static_cast<std::ptrdiff_t>(index), next.end(),
                [](const AnimatedDiffLine& row) { return row.motion != LineMotion::Removing; });
            if (replacement != next.end()) {
                anchor_.lineId = replacement->line.id;
            } else {
                const auto reverseReplacement = std::find_if(
                    next.rbegin(), next.rend(),
                    [](const AnimatedDiffLine& row) { return row.motion != LineMotion::Removing; });
                anchor_.lineId =
                    reverseReplacement == next.rend() ? std::string{} : reverseReplacement->line.id;
            }
        }
    }
    lines_ = std::move(next);
}

void DiffAnimator::advance(float deltaSeconds) {
    if (reducedMotion_) return;
    const float step = std::clamp(deltaSeconds / kMotionSeconds, 0.0F, 1.0F);
    for (AnimatedDiffLine& line : lines_) {
        if (line.motion == LineMotion::Stable) continue;
        line.progress = std::min(1.0F, line.progress + step);
        if (line.progress >= 1.0F && line.motion != LineMotion::Removing) {
            line.motion = LineMotion::Stable;
        }
    }
    lines_.erase(std::remove_if(lines_.begin(), lines_.end(), [](const AnimatedDiffLine& line) {
                     return line.motion == LineMotion::Removing && line.progress >= 1.0F;
                 }),
                 lines_.end());
}

} // namespace chud::vcs
