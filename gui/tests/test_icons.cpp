// Icon atlas loader tests — headless, no GL, no app shell.
//
// The GL-free TextureBackend seam is the point: these tests exercise the real
// loader (inventory contract, layout bounds, theme swap, texture lifetime,
// missing-name fallback) against the committed gui/assets/icons/* and against
// synthetic atlases written to a temp dir, using a counting fake backend.
//
// Usage: test_icons [assets-dir]   (defaults to searching for gui/assets)

#include "icons/icons.h"

#include <imgui.h>

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace chud::icons;

namespace {

struct FakeBackend {
    int uploads = 0;
    int destroys = 0;
    int lastWidth = 0;
    int lastHeight = 0;
    std::set<ImTextureID> live;
    ImTextureID next = 100;

    TextureBackend backend() {
        return {
            [this](const unsigned char* rgba, int width, int height) -> ImTextureID {
                assert(rgba != nullptr && width > 0 && height > 0);
                ++uploads;
                lastWidth = width;
                lastHeight = height;
                const ImTextureID id = next++;
                live.insert(id);
                return id;
            },
            [this](ImTextureID id) {
                ++destroys;
                assert(live.erase(id) == 1 && "double or foreign destroy");
            },
        };
    }
};

// --- minimal stored-deflate PNG writer (mirrors make_icons.py's contract) ---

void putBe32(std::vector<unsigned char>& out, std::uint32_t value) {
    out.push_back(static_cast<unsigned char>(value >> 24));
    out.push_back(static_cast<unsigned char>(value >> 16));
    out.push_back(static_cast<unsigned char>(value >> 8));
    out.push_back(static_cast<unsigned char>(value));
}

void chunk(std::vector<unsigned char>& png, const char* tag,
           const std::vector<unsigned char>& data) {
    putBe32(png, static_cast<std::uint32_t>(data.size()));
    png.insert(png.end(), tag, tag + 4);
    png.insert(png.end(), data.begin(), data.end());
    putBe32(png, 0);  // CRC unchecked by the loader; committed assets carry real ones
}

std::vector<unsigned char> encodePng(int width, int height) {
    std::vector<unsigned char> scan;
    for (int y = 0; y < height; ++y) {
        scan.push_back(0);  // filter 0
        for (int x = 0; x < width * 4; ++x) scan.push_back(0x7F);
    }
    std::vector<unsigned char> idat = {0x78, 0x01};
    std::size_t at = 0;
    while (true) {
        const std::size_t len = std::min<std::size_t>(scan.size() - at, 65535);
        const bool final = at + len == scan.size();
        idat.push_back(final ? 1 : 0);
        idat.push_back(static_cast<unsigned char>(len & 0xFF));
        idat.push_back(static_cast<unsigned char>(len >> 8));
        idat.push_back(static_cast<unsigned char>(~len & 0xFF));
        idat.push_back(static_cast<unsigned char>((~len >> 8) & 0xFF));
        idat.insert(idat.end(), scan.begin() + at, scan.begin() + at + len);
        at += len;
        if (final) break;
    }
    idat.insert(idat.end(), {0, 0, 0, 0});  // adler32, unchecked

    std::vector<unsigned char> png = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
    std::vector<unsigned char> ihdr;
    putBe32(ihdr, static_cast<std::uint32_t>(width));
    putBe32(ihdr, static_cast<std::uint32_t>(height));
    ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});
    chunk(png, "IHDR", ihdr);
    chunk(png, "IDAT", idat);
    chunk(png, "IEND", {});
    return png;
}

void writeFile(const fs::path& path, const std::vector<unsigned char>& bytes) {
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    assert(stream.good());
}

void writeText(const fs::path& path, const std::string& text) {
    std::ofstream stream(path);
    stream << text;
    assert(stream.good());
}

fs::path findAssets(int argc, char** argv) {
    std::vector<fs::path> candidates;
    if (argc > 1) candidates.emplace_back(argv[1]);
    candidates.push_back(fs::path(__FILE__).parent_path().parent_path() / "assets");
    for (const char* relative : {"gui/assets", "../gui/assets", "../../gui/assets",
                                 "../../../gui/assets", "assets", "../assets"}) {
        candidates.emplace_back(relative);
    }
    for (const fs::path& candidate : candidates) {
        std::error_code ec;
        if (fs::is_regular_file(candidate / "icons" / "atlas.json", ec)) return candidate;
    }
    std::cerr << "cannot locate gui/assets (pass it as argv[1])\n";
    std::exit(1);
}

// --- tests -----------------------------------------------------------------

void testInventoryAndUvs(const fs::path& assets, FakeBackend& fake) {
    std::string error;
    const bool ok = loadIcons(assets.string(), fake.backend(), &error);
    if (!ok) std::cerr << "loadIcons: " << error << "\n";
    assert(ok);
    assert(iconsLoaded());
    assert(fake.uploads == 2 && "one texture per theme sheet");
    const ImVec2 atlas = atlasSize();
    assert(atlas.x > 0 && atlas.y > 0);
    assert(fake.lastWidth == static_cast<int>(atlas.x));
    assert(fake.lastHeight == static_cast<int>(atlas.y));

    for (const char* name : kIconNames) {
        for (int size : kCellSizes) {
            const IconUV uv = icon(name, size);
            assert(uv.valid);
            assert(uv.texture != 0);
            assert(uv.width == static_cast<float>(size));
            assert(uv.height == static_cast<float>(size));
            assert(uv.uv0.x >= 0.0f && uv.uv0.y >= 0.0f);
            assert(uv.uv1.x <= 1.0f && uv.uv1.y <= 1.0f);
            assert(uv.uv0.x < uv.uv1.x && uv.uv0.y < uv.uv1.y);
            // UV span must cover exactly the declared cell size in pixels.
            assert(static_cast<int>((uv.uv1.x - uv.uv0.x) * atlas.x + 0.5f) == size);
            assert(static_cast<int>((uv.uv1.y - uv.uv0.y) * atlas.y + 0.5f) == size);
        }
    }
    // Size snapping: anything <= 26 uses the 20 px cell, larger the 32 px cell.
    assert(icon("send", 16).width == 20.0f);
    assert(icon("send", 26).width == 20.0f);
    assert(icon("send", 27).width == 32.0f);
    assert(icon("send", 64).width == 32.0f);
}

void testLayoutBounds() {
    const auto& cells = iconCells();
    assert(cells.size() == kIconNames.size() * kCellSizes.size());
    const ImVec2 atlas = atlasSize();
    for (auto a = cells.begin(); a != cells.end(); ++a) {
        const CellRect& r = a->second;
        assert(r.w > 0 && r.h > 0);
        assert(r.x >= 0 && r.y >= 0);
        assert(r.x + r.w <= static_cast<int>(atlas.x));
        assert(r.y + r.h <= static_cast<int>(atlas.y));
        for (auto b = std::next(a); b != cells.end(); ++b) {
            const CellRect& q = b->second;
            const bool disjoint = r.x + r.w <= q.x || q.x + q.w <= r.x ||
                                  r.y + r.h <= q.y || q.y + q.h <= r.y;
            assert(disjoint && "atlas cells overlap");
        }
    }
}

void testThemeSwapKeepsUvs() {
    setIconTheme(chud::ui::Theme::Dark);
    const IconUV dark = icon("terminal", 20);
    setIconTheme(chud::ui::Theme::Light);
    const IconUV light = icon("terminal", 20);
    assert(dark.valid && light.valid);
    assert(dark.texture != light.texture && "theme switch must swap textures");
    assert(dark.uv0.x == light.uv0.x && dark.uv0.y == light.uv0.y);
    assert(dark.uv1.x == light.uv1.x && dark.uv1.y == light.uv1.y);
    setIconTheme(chud::ui::Theme::Dark);
    assert(iconTheme() == chud::ui::Theme::Dark);
}

void testMissingName() {
    const IconUV missing = icon("extrude-boss", 20);  // CAD vocabulary: must not exist
    assert(!missing.valid);
    assert(missing.texture == 0);
    const IconUV again = icon("extrude-boss", 32);  // second lookup: still invalid
    assert(!again.valid);
}

void testDrawHelper(FakeBackend& fake) {
    // Headless ImGui frame (null backend): enough to run real ImDrawList calls.
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = ImVec2(640.0f, 480.0f);
    io.DeltaTime = 1.0f / 60.0f;
    io.IniFilename = nullptr;  // §13: headless never writes an ini
    io.Fonts->AddFontDefault();
    unsigned char* pixels = nullptr;
    int width = 0;
    int height = 0;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    io.Fonts->SetTexID(static_cast<ImTextureID>(0xF07)); // headless: no renderer uploads it
    ImGui::NewFrame();
    ImDrawList* drawList = ImGui::GetBackgroundDrawList();

    // Known icon: one textured quad from the active theme sheet. AddImage
    // push/pops the texture, so the quad lives in a middle command — find the
    // command bound to one of the fake backend's uploaded sheets.
    const int vtxBefore = drawList->VtxBuffer.Size;
    drawIcon(drawList, "send", ImVec2(10.0f, 10.0f), 20.0f);
    assert(drawList->VtxBuffer.Size == vtxBefore + 4 && "expected one image quad");
    bool sawSheetQuad = false;
    for (const ImDrawCmd& cmd : drawList->CmdBuffer) {
        if (cmd.ElemCount > 0 && fake.live.count(cmd.GetTexID()) == 1) sawSheetQuad = true;
    }
    assert(sawSheetQuad && "quad must reference an uploaded sheet");

    // Missing icon: the honest placeholder still emits geometry — never blank.
    const int vtxMissing = drawList->VtxBuffer.Size;
    drawIcon(drawList, "no-such-icon", ImVec2(40.0f, 10.0f), 20.0f);
    assert(drawList->VtxBuffer.Size > vtxMissing && "fallback must draw, not skip");

    ImGui::Render();
    ImGui::DestroyContext();
}

void testTextureLifetime(FakeBackend& fake) {
    assert(fake.destroys == 0);
    unloadIcons();
    assert(fake.destroys == 2 && "loader owns and releases both theme textures");
    assert(fake.live.empty());
    assert(!iconsLoaded());
    assert(!icon("send", 20).valid);
    assert(iconCells().empty());
    unloadIcons();  // idempotent
    assert(fake.destroys == 2);
}

void testRejectsPartialInventory() {
    const fs::path root = fs::temp_directory_path() / "chud_icons_test";
    fs::remove_all(root);
    fs::create_directories(root / "icons");
    // A structurally valid atlas that carries only one of the required cells.
    writeText(root / "icons" / "atlas.json",
              "{\"atlas_px\":[64,64],\"cell\":{\"send@20\":"
              "{\"x\":2,\"y\":2,\"w\":20,\"h\":20}}}");
    writeFile(root / "icons" / "atlas_dark.png", encodePng(64, 64));
    writeFile(root / "icons" / "atlas_light.png", encodePng(64, 64));

    FakeBackend fake;
    std::string error;
    assert(!loadIcons(root.string(), fake.backend(), &error));
    assert(error.find("missing required cell") != std::string::npos);
    assert(fake.uploads == 0 && fake.destroys == 0);
    assert(!iconsLoaded());
    fs::remove_all(root);
}

void testRejectsBadAssets() {
    FakeBackend fake;
    std::string error;
    assert(!loadIcons("/nonexistent-chudcode-assets", fake.backend(), &error));
    assert(!error.empty());
    assert(!iconsLoaded());
    assert(!loadIcons("/tmp", TextureBackend{}, &error));  // backend required
}

}  // namespace

int main(int argc, char** argv) {
    const fs::path assets = findAssets(argc, argv);
    FakeBackend fake;
    testInventoryAndUvs(assets, fake);
    testLayoutBounds();
    testThemeSwapKeepsUvs();
    testMissingName();
    testDrawHelper(fake);
    testTextureLifetime(fake);
    testRejectsPartialInventory();
    testRejectsBadAssets();
    std::cout << "icon tests passed\n";
    return 0;
}
