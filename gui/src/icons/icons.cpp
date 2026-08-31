#include "icons/icons.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <set>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace chud::icons {
namespace {

struct State {
    bool loaded = false;
    TextureBackend backend;
    ImTextureID textures[2] = {0, 0};  // [dark, light]
    ui::Theme theme = ui::Theme::Dark;
    std::map<std::string, CellRect> cells;
    int atlasW = 0;
    int atlasH = 0;
};

State& state() {
    static State instance;
    return instance;
}

std::set<std::string>& warnedNames() {
    static std::set<std::string> names;
    return names;
}

int themeIndex(ui::Theme theme) {
    return theme == ui::Theme::Light ? 1 : 0;
}

bool fail(std::string* error, std::string message) {
    if (error != nullptr) *error = std::move(message);
    return false;
}

bool readFile(const std::string& path, std::vector<unsigned char>& out) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) return false;
    out.assign(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
    return static_cast<bool>(stream) || stream.eof();
}

std::uint32_t be32(const unsigned char* p) {
    return (std::uint32_t(p[0]) << 24) | (std::uint32_t(p[1]) << 16) |
           (std::uint32_t(p[2]) << 8) | std::uint32_t(p[3]);
}

// Decodes exactly the PNGs make_icons.py writes: 8-bit RGBA, non-interlaced,
// filter 0 on every scanline, IDAT holding a zlib stream of STORED deflate
// blocks (zlib level 0). That contract is what lets this stay ~100 lines with
// no zlib dependency; anything else is rejected with a pointed error.
bool decodePng(const std::vector<unsigned char>& file, int& width, int& height,
               std::vector<unsigned char>& rgba, std::string& error) {
    static const unsigned char kSig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
    if (file.size() < 8 + 25 || !std::equal(kSig, kSig + 8, file.begin())) {
        error = "not a PNG";
        return false;
    }
    std::vector<unsigned char> idat;
    bool sawIhdr = false;
    std::size_t pos = 8;
    while (pos + 8 <= file.size()) {
        const std::uint32_t length = be32(&file[pos]);
        if (pos + 12 + length > file.size()) {
            error = "truncated PNG chunk";
            return false;
        }
        const unsigned char* type = &file[pos + 4];
        const unsigned char* data = &file[pos + 8];
        if (std::equal(type, type + 4, "IHDR")) {
            if (length != 13) {
                error = "bad IHDR";
                return false;
            }
            width = static_cast<int>(be32(data));
            height = static_cast<int>(be32(data + 4));
            const unsigned char bitDepth = data[8];
            const unsigned char colorType = data[9];
            const unsigned char interlace = data[12];
            if (bitDepth != 8 || colorType != 6 || interlace != 0) {
                error = "atlas PNG must be 8-bit RGBA non-interlaced (regenerate "
                        "with gui/scripts/make_icons.py)";
                return false;
            }
            sawIhdr = true;
        } else if (std::equal(type, type + 4, "IDAT")) {
            idat.insert(idat.end(), data, data + length);
        } else if (std::equal(type, type + 4, "IEND")) {
            break;
        }
        pos += 12 + length;
    }
    if (!sawIhdr || width <= 0 || height <= 0) {
        error = "PNG missing IHDR";
        return false;
    }
    if (idat.size() < 2 || (idat[0] & 0x0F) != 8 || (idat[1] & 0x20) != 0) {
        error = "unsupported zlib header in atlas PNG";
        return false;
    }
    const std::size_t stride = static_cast<std::size_t>(width) * 4 + 1;  // +filter byte
    const std::size_t expected = stride * static_cast<std::size_t>(height);
    std::vector<unsigned char> raw;
    raw.reserve(expected);
    std::size_t at = 2;
    for (bool final = false; !final;) {
        if (at >= idat.size()) {
            error = "truncated deflate stream";
            return false;
        }
        const unsigned char header = idat[at];
        final = (header & 1) != 0;
        if (((header >> 1) & 3) != 0) {
            error = "atlas PNG is not stored-deflate; regenerate with "
                    "gui/scripts/make_icons.py (it writes zlib level 0 on purpose)";
            return false;
        }
        if (at + 5 > idat.size()) {
            error = "truncated stored block";
            return false;
        }
        const std::size_t len = idat[at + 1] | (std::size_t(idat[at + 2]) << 8);
        at += 5;
        if (at + len > idat.size()) {
            error = "stored block overruns IDAT";
            return false;
        }
        raw.insert(raw.end(), idat.begin() + at, idat.begin() + at + len);
        at += len;
    }
    if (raw.size() != expected) {
        error = "decoded pixel payload has the wrong size";
        return false;
    }
    rgba.resize(static_cast<std::size_t>(width) * height * 4);
    for (int y = 0; y < height; ++y) {
        const unsigned char* row = raw.data() + static_cast<std::size_t>(y) * stride;
        if (row[0] != 0) {
            error = "atlas PNG uses a scanline filter; regenerate with "
                    "gui/scripts/make_icons.py (filter 0 only)";
            return false;
        }
        std::copy(row + 1, row + stride,
                  rgba.begin() + static_cast<std::size_t>(y) * width * 4);
    }
    return true;
}

std::string cellKey(const char* name, int size) {
    std::string key(name);
    key += '@';
    key += std::to_string(size);
    return key;
}

void destroyTextures(State& s) {
    for (ImTextureID& texture : s.textures) {
        if (texture != 0 && s.backend.destroy) s.backend.destroy(texture);
        texture = 0;
    }
}

}  // namespace

bool loadIcons(const std::string& assetsDir, TextureBackend backend, std::string* error) {
    if (!backend.upload || !backend.destroy) {
        return fail(error, "TextureBackend needs both upload and destroy");
    }
    unloadIcons();
    State& s = state();
    s.backend = std::move(backend);

    const std::string dir = assetsDir + "/icons";
    std::ifstream jsonStream(dir + "/atlas.json");
    if (!jsonStream) return fail(error, "missing " + dir + "/atlas.json");
    const nlohmann::json doc = nlohmann::json::parse(jsonStream, nullptr, false);
    if (doc.is_discarded() || !doc.is_object()) {
        return fail(error, "unparseable " + dir + "/atlas.json");
    }
    const auto atlasPx = doc.find("atlas_px");
    const auto cellsIt = doc.find("cell");
    if (atlasPx == doc.end() || !atlasPx->is_array() || atlasPx->size() != 2 ||
        cellsIt == doc.end() || !cellsIt->is_object()) {
        return fail(error, "atlas.json lacks atlas_px/cell");
    }
    s.atlasW = atlasPx->at(0).get<int>();
    s.atlasH = atlasPx->at(1).get<int>();
    if (s.atlasW <= 0 || s.atlasH <= 0) return fail(error, "bad atlas_px");

    for (const auto& [key, value] : cellsIt->items()) {
        if (!value.is_object()) return fail(error, "bad cell entry " + key);
        CellRect rect{value.value("x", -1), value.value("y", -1),
                      value.value("w", -1), value.value("h", -1)};
        if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
            rect.x + rect.w > s.atlasW || rect.y + rect.h > s.atlasH) {
            return fail(error, "cell " + key + " is outside the atlas");
        }
        s.cells.emplace(key, rect);
    }

    // The inventory is a contract, not a hope: refuse a partial atlas.
    for (const char* name : kIconNames) {
        for (int size : kCellSizes) {
            const std::string key = cellKey(name, size);
            if (s.cells.find(key) == s.cells.end()) {
                s.cells.clear();
                return fail(error, "atlas.json is missing required cell " + key);
            }
        }
    }

    static const char* kSheets[2] = {"atlas_dark.png", "atlas_light.png"};
    for (int i = 0; i < 2; ++i) {
        std::vector<unsigned char> file;
        if (!readFile(dir + "/" + kSheets[i], file)) {
            destroyTextures(s);
            s.cells.clear();
            return fail(error, "missing " + dir + "/" + kSheets[i]);
        }
        int width = 0;
        int height = 0;
        std::vector<unsigned char> rgba;
        std::string decodeError;
        if (!decodePng(file, width, height, rgba, decodeError)) {
            destroyTextures(s);
            s.cells.clear();
            return fail(error, std::string(kSheets[i]) + ": " + decodeError);
        }
        if (width != s.atlasW || height != s.atlasH) {
            destroyTextures(s);
            s.cells.clear();
            return fail(error, std::string(kSheets[i]) +
                                   " dimensions disagree with atlas.json atlas_px");
        }
        s.textures[i] = s.backend.upload(rgba.data(), width, height);
        if (s.textures[i] == 0) {
            destroyTextures(s);
            s.cells.clear();
            return fail(error, std::string("texture upload failed for ") + kSheets[i]);
        }
    }
    s.loaded = true;
    return true;
}

void unloadIcons() {
    State& s = state();
    destroyTextures(s);
    s.cells.clear();
    s.atlasW = 0;
    s.atlasH = 0;
    s.loaded = false;
}

bool iconsLoaded() { return state().loaded; }

void setIconTheme(ui::Theme theme) { state().theme = theme; }

ui::Theme iconTheme() { return state().theme; }

IconUV icon(const char* name, int sizePx) {
    IconUV result;
    State& s = state();
    if (!s.loaded || name == nullptr) return result;
    const int size = sizePx <= 26 ? 20 : 32;
    const auto it = s.cells.find(cellKey(name, size));
    if (it == s.cells.end()) {
        if (warnedNames().insert(name).second) {
            std::fprintf(stderr, "[icons] unknown icon '%s'\n", name);
        }
        return result;
    }
    const CellRect& rect = it->second;
    result.texture = s.textures[themeIndex(s.theme)];
    result.uv0 = ImVec2(static_cast<float>(rect.x) / s.atlasW,
                        static_cast<float>(rect.y) / s.atlasH);
    result.uv1 = ImVec2(static_cast<float>(rect.x + rect.w) / s.atlasW,
                        static_cast<float>(rect.y + rect.h) / s.atlasH);
    result.width = static_cast<float>(rect.w);
    result.height = static_cast<float>(rect.h);
    result.valid = true;
    return result;
}

void drawIcon(ImDrawList* drawList, const char* name, ImVec2 pos, float sizePx,
              ImU32 tint) {
    if (drawList == nullptr || sizePx <= 0.0f) return;
    const ImVec2 max(pos.x + sizePx, pos.y + sizePx);
    const IconUV uv = icon(name, static_cast<int>(sizePx));
    if (uv.valid) {
        drawList->AddImage(uv.texture, pos, max, uv.uv0, uv.uv1, tint);
        return;
    }
    // Honest placeholder (§9: never a blank region): rounded box + diagonal
    // cross in the caller's tint, so a missing cell is visible in review
    // instead of silently rendering nothing.
    const float inset = sizePx * 0.12f;
    const float thickness = sizePx < 24.0f ? 1.0f : 2.0f;
    const ImVec2 a(pos.x + inset, pos.y + inset);
    const ImVec2 b(max.x - inset, max.y - inset);
    drawList->AddRect(a, b, tint, sizePx * 0.15f, 0, thickness);
    drawList->AddLine(a, b, tint, thickness);
    drawList->AddLine(ImVec2(a.x, b.y), ImVec2(b.x, a.y), tint, thickness);
}

const std::map<std::string, CellRect>& iconCells() { return state().cells; }

ImVec2 atlasSize() {
    const State& s = state();
    return ImVec2(static_cast<float>(s.atlasW), static_cast<float>(s.atlasH));
}

}  // namespace chud::icons
