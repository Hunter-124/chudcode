#include "terminal/base64.h"

#include <array>
#include <cstddef>

namespace chud::terminal {
namespace {

constexpr std::uint8_t kInvalid = 0xff;

constexpr std::array<std::uint8_t, 256> makeDecodeTable() {
    std::array<std::uint8_t, 256> table{};
    table.fill(kInvalid);
    for (std::uint8_t i = 0; i < 26; ++i) {
        table[static_cast<unsigned char>('A' + i)] = i;
        table[static_cast<unsigned char>('a' + i)] = static_cast<std::uint8_t>(26 + i);
    }
    for (std::uint8_t i = 0; i < 10; ++i) {
        table[static_cast<unsigned char>('0' + i)] = static_cast<std::uint8_t>(52 + i);
    }
    table[static_cast<unsigned char>('+')] = 62;
    table[static_cast<unsigned char>('/')] = 63;
    return table;
}

constexpr auto kDecode = makeDecodeTable();

}  // namespace

std::optional<std::vector<std::uint8_t>> decodeBase64Strict(std::string_view encoded) {
    if (encoded.empty()) {
        return std::vector<std::uint8_t>{};
    }
    if ((encoded.size() % 4) != 0) {
        return std::nullopt;
    }

    std::size_t padding = 0;
    if (encoded.back() == '=') {
        padding = 1;
        if (encoded[encoded.size() - 2] == '=') {
            padding = 2;
        }
    }

    const std::size_t dataEnd = encoded.size() - padding;
    for (std::size_t i = 0; i < encoded.size(); ++i) {
        if (i >= dataEnd) {
            if (encoded[i] != '=') {
                return std::nullopt;
            }
        } else if (kDecode[static_cast<unsigned char>(encoded[i])] == kInvalid) {
            return std::nullopt;
        }
    }

    if (padding == 1) {
        const auto value = kDecode[static_cast<unsigned char>(encoded[encoded.size() - 2])];
        if ((value & 0x03U) != 0) {
            return std::nullopt;
        }
    } else if (padding == 2) {
        const auto value = kDecode[static_cast<unsigned char>(encoded[encoded.size() - 3])];
        if ((value & 0x0fU) != 0) {
            return std::nullopt;
        }
    }

    std::vector<std::uint8_t> decoded;
    decoded.reserve((encoded.size() / 4) * 3 - padding);
    for (std::size_t i = 0; i < encoded.size(); i += 4) {
        const std::uint32_t a = kDecode[static_cast<unsigned char>(encoded[i])];
        const std::uint32_t b = kDecode[static_cast<unsigned char>(encoded[i + 1])];
        const std::uint32_t c = encoded[i + 2] == '=' ? 0 : kDecode[static_cast<unsigned char>(encoded[i + 2])];
        const std::uint32_t d = encoded[i + 3] == '=' ? 0 : kDecode[static_cast<unsigned char>(encoded[i + 3])];
        const std::uint32_t packed = (a << 18U) | (b << 12U) | (c << 6U) | d;
        decoded.push_back(static_cast<std::uint8_t>(packed >> 16U));
        if (encoded[i + 2] != '=') {
            decoded.push_back(static_cast<std::uint8_t>(packed >> 8U));
        }
        if (encoded[i + 3] != '=') {
            decoded.push_back(static_cast<std::uint8_t>(packed));
        }
    }
    return decoded;
}

}  // namespace chud::terminal
