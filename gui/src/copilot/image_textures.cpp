#include "copilot/image_textures.h"

#include <algorithm>
#include <utility>

// Vendored decoder: stb_image v2.30 (gui/third_party/stb/stb_image.h,
// upstream commit 2c980bb59875b0d32144a71867fbdebb2f77cd20, MIT OR public
// domain; see the license block at the end of that header). Compiled here
// once, PNG + JPEG only — the two formats the composer actually receives —
// with stdio and HDR paths removed so the decoder stays a pure
// bytes-to-RGBA8 function.
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#define STBI_NO_FAILURE_STRINGS
#include "stb/stb_image.h"

namespace chud::copilot {
namespace {

// Sanity ceiling: a draft thumbnail source larger than this is a hostile or
// broken payload, not a screenshot. Rejecting it here bounds decode memory
// (width*height*4 ≤ 256 MiB) before stb allocates anything.
constexpr int kMaxImageDimension = 8192;

int base64Value(char character) {
    if (character >= 'A' && character <= 'Z') return character - 'A';
    if (character >= 'a' && character <= 'z') return character - 'a' + 26;
    if (character >= '0' && character <= '9') return character - '0' + 52;
    if (character == '+') return 62;
    if (character == '/') return 63;
    return -1;
}

// Cache key: mime type plus size plus a 64-bit FNV-1a of the base64 payload.
// The payload is immutable draft data, so a hash key only misidentifies an
// attachment on a 64-bit collision between two attachments in the same
// session draft — and the worst case is showing the other attachment's
// thumbnail, never a crash or a stale texture.
std::string cacheKey(const ImageContent& image) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (const char character : image.data) {
        hash ^= static_cast<unsigned char>(character);
        hash *= 1099511628211ULL;
    }
    std::string key = image.mimeType;
    key += '#';
    key += std::to_string(image.data.size());
    key += '#';
    key += std::to_string(hash);
    return key;
}

}  // namespace

std::optional<std::vector<unsigned char>> decodeBase64(std::string_view encoded) {
    std::vector<unsigned char> output;
    output.reserve(encoded.size() / 4U * 3U);
    std::uint32_t accumulator = 0;
    int bits = 0;
    std::size_t padding = 0;
    for (const char character : encoded) {
        if (character == ' ' || character == '\n' || character == '\r' ||
            character == '\t')
            continue;
        if (character == '=') {
            ++padding;
            continue;
        }
        if (padding > 0) return std::nullopt;  // data after '='
        const int value = base64Value(character);
        if (value < 0) return std::nullopt;
        accumulator = (accumulator << 6) | static_cast<std::uint32_t>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output.push_back(static_cast<unsigned char>((accumulator >> bits) & 0xFFU));
        }
    }
    if (padding > 2) return std::nullopt;
    // Trailing group must be consistent: 2 chars + '==' leaves 4 bits, 3 chars
    // + '=' leaves 2 bits; anything else is a torn payload.
    if ((bits == 4 && padding != 2) || (bits == 2 && padding != 1) ||
        (bits == 0 && padding != 0) || bits == 6)
        return std::nullopt;
    if (bits > 0 && (accumulator & ((1U << bits) - 1U)) != 0) return std::nullopt;
    return output;
}

DecodedImage decodeImageBytes(const unsigned char* bytes, std::size_t size) {
    DecodedImage image;
    if (bytes == nullptr || size == 0 || size > (1U << 30)) return image;

    int width = 0;
    int height = 0;
    int components = 0;
    if (!stbi_info_from_memory(bytes, static_cast<int>(size), &width, &height,
                               &components))
        return image;
    if (width <= 0 || height <= 0 || width > kMaxImageDimension ||
        height > kMaxImageDimension)
        return image;

    unsigned char* pixels = stbi_load_from_memory(bytes, static_cast<int>(size),
                                                  &width, &height, &components, 4);
    if (pixels == nullptr) return image;
    image.width = width;
    image.height = height;
    image.rgba.assign(pixels, pixels + static_cast<std::size_t>(width) *
                                           static_cast<std::size_t>(height) * 4U);
    stbi_image_free(pixels);
    return image;
}

ImageTextureCache::ImageTextureCache(icons::TextureBackend backend,
                                     std::size_t maxTextures)
    : backend_(std::move(backend)), maxTextures_(std::max<std::size_t>(1, maxTextures)) {}

ImageTextureCache::~ImageTextureCache() { clear(); }

void ImageTextureCache::destroyEntry(Entry& entry) {
    if (entry.texture.valid && entry.texture.texture != 0 && backend_.destroy) {
        backend_.destroy(entry.texture.texture);
        --textures_;
    }
    entry.texture = {};
}

void ImageTextureCache::evictOverflow() {
    // Walk from the least-recently-used end, dropping textures (and their
    // entries) until back under the bound. Invalid entries hold no texture and
    // are kept: remembering a failed decode is the cheap part.
    auto iterator = order_.end();
    while (textures_ > maxTextures_ && iterator != order_.begin()) {
        --iterator;
        if (!iterator->texture.valid) continue;
        destroyEntry(*iterator);
        index_.erase(iterator->key);
        iterator = order_.erase(iterator);
    }
}

ImageTexture ImageTextureCache::acquire(const ImageContent& image) {
    if (image.data.empty()) return {};
    const std::string key = cacheKey(image);
    if (const auto found = index_.find(key); found != index_.end()) {
        order_.splice(order_.begin(), order_, found->second);
        return found->second->texture;
    }

    Entry entry;
    entry.key = key;
    if (backend_.upload && backend_.destroy) {
        if (const auto bytes = decodeBase64(image.data)) {
            const DecodedImage decoded = decodeImageBytes(bytes->data(), bytes->size());
            if (decoded.valid()) {
                const ImTextureID texture =
                    backend_.upload(decoded.rgba.data(), decoded.width, decoded.height);
                if (texture != 0) {
                    entry.texture = {texture, decoded.width, decoded.height, true};
                    ++textures_;
                }
            }
        }
    }

    order_.push_front(std::move(entry));
    index_.emplace(order_.front().key, order_.begin());
    evictOverflow();
    return order_.front().texture;
}

void ImageTextureCache::clear() {
    for (Entry& entry : order_) destroyEntry(entry);
    order_.clear();
    index_.clear();
    textures_ = 0;
}

}  // namespace chud::copilot
