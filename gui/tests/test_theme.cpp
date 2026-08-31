// Shared UI vocabulary tests — headless, no GL or application shell.
// Usage: test_theme [repository-root]

#include "theme/anim.h"
#include "theme/theme.h"
#include "widgets/kit.h"

#include <nlohmann/json.hpp>

#include <array>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;
using Json = nlohmann::json;

namespace {

fs::path findRoot(int argc, char** argv) {
    std::vector<fs::path> candidates;
    if (argc > 1) candidates.emplace_back(argv[1]);
    candidates.push_back(fs::path(__FILE__).parent_path().parent_path().parent_path());
    for (const char* relative : {".", "..", "../..", "../../.."}) {
        candidates.emplace_back(relative);
    }
    for (const fs::path& candidate : candidates) {
        std::error_code error;
        if (fs::is_regular_file(candidate / "assets" / "ui-shared-manifest.json", error)) {
            return fs::canonical(candidate, error);
        }
    }
    std::cerr << "cannot locate assets/ui-shared-manifest.json (pass repository root)\n";
    std::exit(1);
}

Json readManifest(const fs::path& root) {
    std::ifstream stream(root / "assets" / "ui-shared-manifest.json");
    assert(stream.good());
    return Json::parse(stream);
}

template <std::size_t Size>
void assertNames(const Json& value, const std::array<std::string_view, Size>& expected) {
    assert(value.is_array());
    assert(value.size() == expected.size());
    for (std::size_t index = 0; index < expected.size(); ++index) {
        assert(value[index].get<std::string>() == expected[index]);
    }
}

bool sameColor(ImVec4 left, ImVec4 right) {
    constexpr float epsilon = 0.000001F;
    return std::abs(left.x - right.x) < epsilon &&
           std::abs(left.y - right.y) < epsilon &&
           std::abs(left.z - right.z) < epsilon &&
           std::abs(left.w - right.w) < epsilon;
}

void assertVisible(ImVec4 color) {
    assert(std::isfinite(color.x));
    assert(std::isfinite(color.y));
    assert(std::isfinite(color.z));
    assert(std::isfinite(color.w));
    assert(color.w > 0.0F);
}

void testManifestVocabulary(const Json& manifest) {
    assert(manifest.at("schema").get<std::string>() == chud::ui::shared::kManifestSchema);
    assertNames(manifest.at("semanticRoles"), chud::ui::shared::kSemanticRoleNames);
    assertNames(manifest.at("tones"), chud::ui::shared::kToneNames);
    assertNames(manifest.at("densities"), chud::ui::shared::kDensityNames);

    const auto& animation = manifest.at("animationSeconds");
    assert(animation.at("instant").get<float>() == chud::anim::kInstant);
    assert(animation.at("fast").get<float>() == chud::anim::kFast);
    assert(animation.at("base").get<float>() == chud::anim::kBase);
    assert(animation.at("slow").get<float>() == chud::anim::kSlow);
    assert(animation.at("stagger").get<float>() == chud::anim::kStagger);
    assert(animation.at("breathe").get<float>() == chud::anim::kBreathe);
    assert(animation.at("march").get<float>() == chud::anim::kMarch);
    assert(animation.at("maxDeltaTime").get<float>() == chud::anim::kMaxDeltaTime);

    const auto& thresholds = manifest.at("usageThresholds");
    assert(thresholds.at("warning").get<float>() ==
           chud::ui::shared::kUsageThresholds.warning);
    assert(thresholds.at("critical").get<float>() ==
           chud::ui::shared::kUsageThresholds.critical);
    assert(manifest.at("iconPipeline").at("version").get<std::string>() ==
           chud::ui::shared::kIconPipelineVersion);

    const auto& fonts = manifest.at("fonts").at("files");
    assert(fonts.size() == chud::ui::shared::kFontAssets.size());
    for (std::size_t index = 0; index < chud::ui::shared::kFontAssets.size(); ++index) {
        const auto& expected = chud::ui::shared::kFontAssets[index];
        assert(fonts[index].at("file").get<std::string>() == expected.file);
        assert(fonts[index].at("sha256").get<std::string>() == expected.sha256);
    }
}

void testSurfaceRoles(chud::ui::Theme theme) {
    chud::ui::applyTheme(theme, 1.0F);
    const chud::ui::Palette& palette = chud::ui::palette();

    assert(sameColor(palette.usageTrack, palette.gaugeTrack));
    assert(sameColor(palette.usageOk, palette.statusOk));
    assert(sameColor(palette.usageWarn, palette.statusWarn));
    assert(sameColor(palette.usageErr, palette.statusErr));
    assert(sameColor(palette.usageUnknown, palette.statusPending));
    assert(sameColor(palette.attachmentBg, palette.codeBg));
    assert(sameColor(palette.attachmentBorder, palette.border));
    assert(sameColor(palette.attachmentHovered, palette.buttonHovered));
    assert(sameColor(palette.attachmentSelected, palette.accentSelection));
    assert(sameColor(palette.dagEdge, palette.borderStrong));
    assert(sameColor(palette.dagEdgeActive, palette.accent));
    assert(sameColor(palette.dagNodeBg, palette.panelBg));
    assert(sameColor(palette.dagNodeHovered, palette.buttonHovered));

    for (const ImVec4 color : {
             palette.usageTrack, palette.usageOk, palette.usageWarn,
             palette.usageErr, palette.usageUnknown, palette.attachmentBg,
             palette.attachmentBorder, palette.attachmentHovered,
             palette.attachmentSelected, palette.dagEdge, palette.dagEdgeActive,
             palette.dagNodeBg, palette.dagNodeHovered,
         }) {
        assertVisible(color);
    }
}

}  // namespace

int main(int argc, char** argv) {
    const Json manifest = readManifest(findRoot(argc, argv));
    testManifestVocabulary(manifest);
    testSurfaceRoles(chud::ui::Theme::Dark);
    testSurfaceRoles(chud::ui::Theme::Light);
    std::cout << "theme and shared manifest tests passed\n";
    return 0;
}
