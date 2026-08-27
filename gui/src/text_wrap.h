#pragma once

#include "imgui.h"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace omp::gui {

struct WrappedText {
    std::string text;
    std::vector<std::size_t> softBreaks;
};

WrappedText wrapProse(std::string_view source, float width, ImFont& font, float fontSize);
std::string normalizeSoftBreaks(const WrappedText& wrapped);
std::string normalizeSoftBreaks(const WrappedText& wrapped, std::size_t begin, std::size_t end);
std::size_t utf8ByteOffset(std::string_view text, int characterOffset);

}  // namespace omp::gui
