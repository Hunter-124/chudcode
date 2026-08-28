#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chud::vcs {

enum class DiffLineKind : std::uint8_t { Context, Addition, Deletion, NoNewline };

struct DiffRange {
    std::int64_t start = 0;
    std::int64_t count = 0;
    friend bool operator==(const DiffRange&, const DiffRange&) = default;
};

struct DiffLine {
    std::string id;
    std::string hunkId;
    DiffLineKind kind = DiffLineKind::Context;
    std::string text;
    std::optional<std::int64_t> oldLine;
    std::optional<std::int64_t> newLine;
    friend bool operator==(const DiffLine&, const DiffLine&) = default;
};

struct DiffHunk {
    std::string id;
    std::string header;
    DiffRange oldRange;
    DiffRange newRange;
    std::vector<DiffLine> lines;
    friend bool operator==(const DiffHunk&, const DiffHunk&) = default;
};

enum class DiffFileKind : std::uint8_t {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Binary,
    ModeChanged,
    Submodule,
};

struct DiffFile {
    std::string id;
    std::string oldPath;
    std::string newPath;
    DiffFileKind kind = DiffFileKind::Modified;
    bool binary = false;
    bool renamed = false;
    bool modeChanged = false;
    bool submodule = false;
    std::vector<std::string> metadata;
    std::vector<DiffHunk> hunks;

    [[nodiscard]] std::string_view displayPath() const noexcept;
    friend bool operator==(const DiffFile&, const DiffFile&) = default;
};

struct DiffDocument {
    std::vector<DiffFile> files;
    std::vector<std::string> warnings;
    friend bool operator==(const DiffDocument&, const DiffDocument&) = default;
};

enum class HunkAction : std::uint8_t { Stage, Unstage, Revert };

struct HunkGate {
    bool allowed = false;
    std::string reason;
    friend bool operator==(const HunkGate&, const HunkGate&) = default;
};

// Parses ordinary git unified output without interpreting paths as commands or
// filesystem locations. IDs are deterministic functions of semantic positions,
// so array reordering and reparsing do not perturb selection/animation state.
[[nodiscard]] DiffDocument parseUnifiedDiff(std::string_view unified);
[[nodiscard]] std::string stableDiffId(std::string_view domain, std::string_view value);
[[nodiscard]] HunkGate gateHunkAction(const DiffFile& file, const DiffHunk& hunk,
                                      HunkAction action);

struct ScrollAnchor {
    std::string lineId;
    float offset = 0.0F;
    friend bool operator==(const ScrollAnchor&, const ScrollAnchor&) = default;
};

enum class LineMotion : std::uint8_t { Stable, Inserting, Changing, Removing };

struct AnimatedDiffLine {
    DiffLine line;
    LineMotion motion = LineMotion::Stable;
    float progress = 1.0F;
    friend bool operator==(const AnimatedDiffLine&, const AnimatedDiffLine&) = default;
};

class DiffAnimator {
public:
    void setReducedMotion(bool reduced) noexcept;
    [[nodiscard]] bool reducedMotion() const noexcept { return reducedMotion_; }
    void setScrollAnchor(ScrollAnchor anchor);
    [[nodiscard]] const ScrollAnchor& scrollAnchor() const noexcept { return anchor_; }

    void reconcile(const DiffDocument& document);
    void advance(float deltaSeconds);
    [[nodiscard]] const std::vector<AnimatedDiffLine>& lines() const noexcept { return lines_; }

private:
    static std::vector<DiffLine> flatten(const DiffDocument& document);

    std::vector<AnimatedDiffLine> lines_;
    ScrollAnchor anchor_;
    bool reducedMotion_ = false;
};

} // namespace chud::vcs
