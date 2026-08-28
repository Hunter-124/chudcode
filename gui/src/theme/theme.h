#pragma once

#include <array>
#include <utility>

#include <imgui.h>

namespace chud::ui {

enum class Theme { Dark, Light };

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
