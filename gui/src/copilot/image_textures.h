#pragma once

// Draft-attachment image textures for the copilot composer
// (docs/UI_FOUNDATION.md §9 empty/blocked contract, §11 composer).
//
// The composer holds ImageContent attachments as base64 file bytes
// (PNG/JPEG/…); this module turns them into bounded-lifetime GPU textures so
// the GUI shows the real pixels instead of a mime-type chip. Decoding uses the
// vendored stb_image v2.30 (gui/third_party/stb/stb_image.h, upstream commit
// 2c980bb59875b0d32144a71867fbdebb2f77cd20, dual-licensed MIT / public domain
// — license text at the end of that header), compiled PNG+JPEG-only.
//
// Texture creation is injected through the same chud::icons::TextureBackend
// seam the icon atlas uses, so everything here is testable headless and the
// cache owns — and provably releases — every texture it uploads. A decode
// failure is cached as an invalid entry: callers render an honest typed
// fallback ("image/png · preview unavailable"), never a blank region and
// never a repeated decode of the same broken payload.

#include <cstddef>
#include <cstdint>
#include <list>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <imgui.h>

#include "icons/icons.h"
#include "protocol/wire_types.h"

namespace chud::copilot {

// Decoded RGBA8 pixels; GL-free.
struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<unsigned char> rgba;

    [[nodiscard]] bool valid() const noexcept {
        return width > 0 && height > 0 &&
               rgba.size() == static_cast<std::size_t>(width) *
                                  static_cast<std::size_t>(height) * 4U;
    }
};

// Canonical RFC 4648 base64 (padding required, whitespace tolerated — the
// wire layer already normalizes, but drafts can also carry pasted data).
// Rejects URL-safe alphabets and misplaced padding.
[[nodiscard]] std::optional<std::vector<unsigned char>> decodeBase64(
    std::string_view encoded);

// Decodes PNG/JPEG file bytes into RGBA8. Anything undecodable returns an
// empty (invalid) image — the caller decides how to say so honestly.
[[nodiscard]] DecodedImage decodeImageBytes(const unsigned char* bytes,
                                            std::size_t size);

struct ImageTexture {
    ImTextureID texture = 0;
    int width = 0;
    int height = 0;
    // false: bytes did not decode (or no backend). The caller MUST render a
    // typed fallback naming the mime type, never a blank thumbnail.
    bool valid = false;
};

// Keyed, bounded LRU texture cache for draft attachments.
//
// At most `maxTextures` decoded textures stay uploaded; acquiring past the
// bound destroys the least-recently-used texture through the backend. Failed
// decodes are remembered (cheaply, no texture) so a broken attachment is
// decoded exactly once. clear()/destruction release every live texture.
class ImageTextureCache {
public:
    explicit ImageTextureCache(icons::TextureBackend backend,
                               std::size_t maxTextures = 24);
    ~ImageTextureCache();
    ImageTextureCache(const ImageTextureCache&) = delete;
    ImageTextureCache& operator=(const ImageTextureCache&) = delete;

    [[nodiscard]] ImageTexture acquire(const ImageContent& image);
    void clear();

    [[nodiscard]] std::size_t textureCount() const noexcept { return textures_; }
    [[nodiscard]] std::size_t entryCount() const noexcept { return index_.size(); }
    [[nodiscard]] std::size_t capacity() const noexcept { return maxTextures_; }

private:
    struct Entry {
        std::string key;
        ImageTexture texture;
    };

    void evictOverflow();
    void destroyEntry(Entry& entry);

    icons::TextureBackend backend_;
    std::size_t maxTextures_;
    std::size_t textures_ = 0;
    std::list<Entry> order_;  // front = most recently used
    std::unordered_map<std::string, std::list<Entry>::iterator> index_;
};

}  // namespace chud::copilot
