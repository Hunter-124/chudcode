#pragma once

#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace chud::terminal {

// Decodes canonical RFC 4648 base64. Whitespace, URL-safe characters,
// misplaced padding, and non-zero discarded bits are rejected.
[[nodiscard]] std::optional<std::vector<std::uint8_t>> decodeBase64Strict(std::string_view encoded);

}  // namespace chud::terminal
