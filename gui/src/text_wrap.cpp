#include "text_wrap.h"

#include <algorithm>

namespace omp::gui {
namespace {

bool isContinuationByte(unsigned char value) {
    return (value & 0xC0U) == 0x80U;
}

const char* safeWrapEnd(const char* begin, const char* end, const char* candidate) {
    if (candidate <= begin) return std::min(begin + 1, end);
    while (candidate < end && isContinuationByte(static_cast<unsigned char>(*candidate))) {
        ++candidate;
    }
    return candidate;
}

}  // namespace

WrappedText wrapProse(std::string_view source, float width, ImFont& font, float fontSize) {
    WrappedText result;
    result.text.reserve(source.size() + source.size() / 32);
    if (source.empty() || width <= 0.0F || fontSize <= 0.0F) {
        result.text.assign(source);
        return result;
    }

    const float scale = fontSize / font.FontSize;
    const char* sourceBegin = source.data();
    const char* sourceEnd = sourceBegin + source.size();
    const char* lineBegin = sourceBegin;
    while (lineBegin < sourceEnd) {
        const char* hardBreak = std::find(lineBegin, sourceEnd, '\n');
        const char* cursor = lineBegin;
        while (cursor < hardBreak) {
            const char* wrapEnd = font.CalcWordWrapPositionA(scale, cursor, hardBreak, width);
            wrapEnd = safeWrapEnd(cursor, hardBreak, wrapEnd);
            if (wrapEnd >= hardBreak) {
                result.text.append(cursor, hardBreak);
                cursor = hardBreak;
                break;
            }

            result.text.append(cursor, wrapEnd);
            cursor = wrapEnd;
            // ImGui skips blanks after a wrap. Keep them as trailing whitespace so
            // deleting our synthetic newline reconstructs the source byte-for-byte.
            while (cursor < hardBreak && (*cursor == ' ' || *cursor == '\t')) {
                result.text.push_back(*cursor++);
            }
            result.softBreaks.push_back(result.text.size());
            result.text.push_back('\n');
        }

        if (hardBreak == sourceEnd) break;
        result.text.push_back('\n');
        lineBegin = hardBreak + 1;
    }
    return result;
}

std::string normalizeSoftBreaks(const WrappedText& wrapped, std::size_t begin, std::size_t end) {
    begin = std::min(begin, wrapped.text.size());
    end = std::min(std::max(end, begin), wrapped.text.size());
    std::string normalized;
    normalized.reserve(end - begin);
    auto soft = std::lower_bound(wrapped.softBreaks.begin(), wrapped.softBreaks.end(), begin);
    for (std::size_t index = begin; index < end; ++index) {
        if (soft != wrapped.softBreaks.end() && *soft == index) {
            ++soft;
            continue;
        }
        normalized.push_back(wrapped.text[index]);
    }
    return normalized;
}

std::string normalizeSoftBreaks(const WrappedText& wrapped) {
    return normalizeSoftBreaks(wrapped, 0, wrapped.text.size());
}

std::size_t utf8ByteOffset(std::string_view text, int characterOffset) {
    if (characterOffset <= 0) return 0;
    std::size_t offset = 0;
    int characters = 0;
    while (offset < text.size() && characters < characterOffset) {
        ++offset;
        while (offset < text.size() && isContinuationByte(static_cast<unsigned char>(text[offset]))) {
            ++offset;
        }
        ++characters;
    }
    return offset;
}

}  // namespace omp::gui
