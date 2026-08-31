#pragma once

#include <array>
#include <string_view>
#include <utility>

#include <imgui.h>

namespace chud::ui {

enum class Theme { Dark, Light };

// Cross-product vocabulary is frozen in assets/ui-shared-manifest.json. These
// constexpr mirrors make drift visible to native consumers at compile time;
// scripts/verify-ui-shared.ts verifies every value against the manifest.
namespace shared {
inline constexpr std::string_view kManifestSchema = "chud-ui-shared-v1";
inline constexpr auto kSemanticRoleNames = std::to_array<std::string_view>({
    "windowBg", "panelBg", "headerBg", "popupBg", "statusBg",
    "border", "borderStrong", "shadow",
    "text", "textDim", "textDisabled", "textOnAccent",
    "button", "buttonHovered", "buttonActive",
    "frameBg", "frameHovered", "frameActive",
    "accent", "accentDim", "secondary", "secondaryDim",
    "accentSoft", "accentMid", "accentSelection", "accentHover",
    "accentOverlayBorder", "accentChip", "accentTreeHover",
    "codeBg", "proseBg", "proseText",
    "statusOk", "statusWarn", "statusErr", "statusInfo", "statusPending",
    "statusOkWash", "statusWarnWash", "statusErrWash", "statusInfoWash",
    "statusPendingWash",
    "graphNeutral", "graphAccent", "graphOk", "graphWarn", "graphErr",
    "graphInfo",
    "glassBg", "glassBorder", "glassHighlight", "glassShadow", "glassText",
    "glassTextDim", "glassRow", "glassCard", "glassSelectionGlow",
    "gaugeTrack", "gaugeFill", "gaugeSecondary", "gaugeOverflow",
    "scrollPillTrack", "scrollPillThumb", "scrollPillHovered",
    "scrollPillActive",
    "tabStripBg", "tabBg", "tabHovered", "tabActive", "tabUnderline",
    "rule", "disabledWash", "focusRing",
    "usageTrack", "usageOk", "usageWarn", "usageErr", "usageUnknown",
    "attachmentBg", "attachmentBorder", "attachmentHovered",
    "attachmentSelected",
    "dagEdge", "dagEdgeActive", "dagNodeBg", "dagNodeHovered",
});
inline constexpr auto kToneNames = std::to_array<std::string_view>(
    {"Neutral", "Accent", "Ok", "Warn", "Err", "Info"});
inline constexpr auto kDensityNames =
    std::to_array<std::string_view>({"Compact", "Cozy", "Roomy"});

struct AnimationTokens {
    float instant;
    float fast;
    float base;
    float slow;
    float stagger;
    float breathe;
    float march;
    float maxDeltaTime;
};
inline constexpr AnimationTokens kAnimationSeconds{
    0.08f, 0.14f, 0.22f, 0.38f, 0.02f, 2.40f, 1.10f, 0.05f};

struct UsageThresholds {
    float warning;
    float critical;
};
inline constexpr UsageThresholds kUsageThresholds{0.50f, 0.90f};
static_assert(kUsageThresholds.warning < kUsageThresholds.critical);

inline constexpr std::string_view kIconPipelineVersion = "chudcode-icons-v1";

struct FontAsset {
    std::string_view file;
    std::string_view sha256;
};
inline constexpr auto kFontAssets = std::to_array<FontAsset>({
    {"Rubik-Regular.ttf", "f143dbaec0821f3a8f090cdf47228198c7ca569d311458e4901ce6a9fc918304"},
    {"Rubik-Medium.ttf", "72e2efa7755011d26bf5af8ced5a83e7fdb5a12b363b313f3ab9ae2979a8e26d"},
    {"Rubik-SemiBold.ttf", "cd2f09dfa112936487d6d1f70b4b8e6697d2875625e2f55e00c4d63a12c54ab8"},
    {"Rubik-Bold.ttf", "5bad3810660eac7e3ad47f22cc835f083a5926d308aa04b5bb9c3371bcb4fa45"},
    {"JetBrainsMono-Regular.ttf", "e6fd0d7e91550b3ed2b735d4312474362c4716edc4fc0577a0f61ed782d5aed1"},
    {"JetBrainsMono-Medium.ttf", "d16e6dc99672734698d629705f617c79f6eb6040f5113efe3a145204dc988109"},
});
}  // namespace shared

struct AccentAlphas {
    float soft;
    float mid;
    float selection;
    float hover;
    float overlayBorder;
    float chip;
    float treeHover;
};

// Semantic colors are the only colors application modules consume. Keeping the
// full vocabulary here makes dark/light parity visible at review time.
struct Palette {
    ImVec4 windowBg;
    ImVec4 panelBg;
    ImVec4 headerBg;
    ImVec4 popupBg;
    ImVec4 statusBg;
    ImVec4 border;
    ImVec4 borderStrong;
    ImVec4 shadow;

    ImVec4 text;
    ImVec4 textDim;
    ImVec4 textDisabled;
    ImVec4 textOnAccent;

    ImVec4 button;
    ImVec4 buttonHovered;
    ImVec4 buttonActive;
    ImVec4 frameBg;
    ImVec4 frameHovered;
    ImVec4 frameActive;

    ImVec4 accent;
    ImVec4 accentDim;
    ImVec4 secondary;
    ImVec4 secondaryDim;
    ImVec4 accentSoft;
    ImVec4 accentMid;
    ImVec4 accentSelection;
    ImVec4 accentHover;
    ImVec4 accentOverlayBorder;
    ImVec4 accentChip;
    ImVec4 accentTreeHover;

    ImVec4 codeBg;
    ImVec4 proseBg;
    ImVec4 proseText;

    ImVec4 statusOk;
    ImVec4 statusWarn;
    ImVec4 statusErr;
    ImVec4 statusInfo;
    ImVec4 statusPending;
    ImVec4 statusOkWash;
    ImVec4 statusWarnWash;
    ImVec4 statusErrWash;
    ImVec4 statusInfoWash;
    ImVec4 statusPendingWash;

    ImVec4 diffAdd;
    ImVec4 diffDelete;
    ImVec4 diffHunk;
    ImVec4 diffHeader;
    ImVec4 diffAddWash;
    ImVec4 diffDeleteWash;
    ImVec4 diffHunkWash;

    ImVec4 editorGutterBg;
    ImVec4 editorGutterText;
    ImVec4 editorLineHighlight;
    ImVec4 editorCurrentLine;
    ImVec4 searchMatch;
    ImVec4 searchCurrent;

    ImVec4 terminalBackground;
    ImVec4 terminalForeground;
    ImVec4 terminalSelection;
    std::array<ImVec4, 16> terminalAnsi;
    ImVec4 consoleDefault;
    ImVec4 consoleOk;
    ImVec4 consoleWarn;
    ImVec4 consoleErr;
    ImVec4 consoleDim;

    ImVec4 graphNeutral;
    ImVec4 graphAccent;
    ImVec4 graphOk;
    ImVec4 graphWarn;
    ImVec4 graphErr;
    ImVec4 graphInfo;

    ImVec4 glassBg;
    ImVec4 glassBorder;
    ImVec4 glassHighlight;
    ImVec4 glassShadow;
    ImVec4 glassText;
    ImVec4 glassTextDim;
    ImVec4 glassRow;
    ImVec4 glassCard;
    ImVec4 glassSelectionGlow;

    ImVec4 gaugeTrack;
    ImVec4 gaugeFill;
    ImVec4 gaugeSecondary;
    ImVec4 gaugeOverflow;

    ImVec4 scrollPillTrack;
    ImVec4 scrollPillThumb;
    ImVec4 scrollPillHovered;
    ImVec4 scrollPillActive;

    // Cross-product surface roles. Values remain product-owned; only names and
    // meanings are shared with Chudware.
    ImVec4 usageTrack;    // unused context capacity
    ImVec4 usageOk;       // fraction < shared::kUsageThresholds.warning
    ImVec4 usageWarn;     // warning <= fraction < critical
    ImVec4 usageErr;      // fraction >= critical
    ImVec4 usageUnknown;  // server did not provide authoritative usage

    ImVec4 attachmentBg;
    ImVec4 attachmentBorder;
    ImVec4 attachmentHovered;
    ImVec4 attachmentSelected;

    ImVec4 dagEdge;
    ImVec4 dagEdgeActive;
    ImVec4 dagNodeBg;
    ImVec4 dagNodeHovered;

    ImVec4 tabStripBg;
    ImVec4 tabBg;
    ImVec4 tabHovered;
    ImVec4 tabActive;
    ImVec4 tabUnderline;

    ImVec4 diagnosticError;
    ImVec4 diagnosticWarn;
    ImVec4 diagnosticHint;

    ImVec4 rule;
    ImVec4 disabledWash;
    ImVec4 focusRing;

    AccentAlphas accentAlphas;
};

struct Fonts {
    ImFont* body = nullptr;
    ImFont* medium = nullptr;
    ImFont* h1 = nullptr;
    ImFont* h2 = nullptr;
    ImFont* mono = nullptr;
};


struct Radii {
    float window;
    float child;
    float frame;
    float popup;
    float scrollbar;
    float grab;
    float tab;
};
namespace metrics {
inline constexpr float kGrid = 4.0f;
inline constexpr float kChatScrollbarLane = 13.0f;
inline constexpr float kDockedCopilotWidth = 340.0f;
inline constexpr float kDockedCopilotMinWidth = 200.0f;
inline constexpr int kComposerMaxLines = 6;
inline constexpr float kProseHeightCap = 150.0f;
inline constexpr float kLiveStreamHeightCap = 420.0f;
inline constexpr float kCodeDiffHeightCap = 220.0f;

[[nodiscard]] float scale();
[[nodiscard]] float px(float logical);
[[nodiscard]] float U(float units);
[[nodiscard]] float stroke(float logical = 1.0f);
[[nodiscard]] float rounding(float logical);
}  // namespace metrics

[[nodiscard]] const Palette& palette();
[[nodiscard]] const Fonts& fonts();
[[nodiscard]] const Radii& radii();
[[nodiscard]] Theme theme();
[[nodiscard]] float uiScale();
[[nodiscard]] AccentAlphas accentAlphas(Theme value);
[[nodiscard]] std::pair<ImVec4, ImVec4> accentColors();

// Reapplying never compounds scale: the style is reset to its unscaled
// baseline before exactly one ScaleAllSizes call.
void applyTheme(Theme value, float scale);
void setAccentColors(ImVec4 primary, ImVec4 secondary);

// Loads only the licensed UI faces. A false result means at least one face was
// unavailable; the returned Fonts remain safe to inspect.
[[nodiscard]] bool loadFonts(const char* assetsDir, float scale);

[[nodiscard]] ImVec4 withAlpha(ImVec4 color, float alpha);
[[nodiscard]] ImU32 toU32(ImVec4 color);
[[nodiscard]] ImVec4 mix(ImVec4 a, ImVec4 b, float amount);
[[nodiscard]] float luminance(ImVec4 color);
[[nodiscard]] ImVec4 contrastText(ImVec4 surface);

}  // namespace chud::ui
