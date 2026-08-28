#include "theme/theme.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <string>

namespace chud::ui {
namespace {

constexpr float kDefaultScale = 1.0f;

Palette gPalette{};
Fonts gFonts{};
Radii gRadii{};
Theme gTheme = Theme::Dark;
float gScale = kDefaultScale;
ImVec4 gPrimary{242.0f / 255.0f, 130.0f / 255.0f, 22.0f / 255.0f, 1.0f};
ImVec4 gSecondary{0.0f, 120.0f / 255.0f, 215.0f / 255.0f, 1.0f};

ImVec4 rgba(float r, float g, float b, float a = 1.0f) { return {r, g, b, a}; }

ImVec4 rgb8(int r, int g, int b, float a = 1.0f) {
    return {static_cast<float>(r) / 255.0f, static_cast<float>(g) / 255.0f,
            static_cast<float>(b) / 255.0f, a};
}

ImVec4 dimRgb(ImVec4 color) {
    color.x *= 0.70f;
    color.y *= 0.70f;
    color.z *= 0.70f;
    return color;
}

Palette darkPalette() {
    Palette p{};
    p.windowBg = rgba(0.082f, 0.090f, 0.110f);
    p.panelBg = rgba(0.094f, 0.106f, 0.129f);
    p.headerBg = rgba(0.110f, 0.125f, 0.157f);
    p.popupBg = rgba(0.106f, 0.118f, 0.145f);
    p.statusBg = rgba(0.075f, 0.086f, 0.108f);
    p.border = rgba(0.165f, 0.184f, 0.227f, 0.85f);
    p.borderStrong = rgba(0.245f, 0.278f, 0.337f, 0.95f);
    p.shadow = rgba(0.0f, 0.0f, 0.0f, 0.40f);

    p.text = rgba(0.898f, 0.918f, 0.945f);
    p.textDim = rgba(0.620f, 0.660f, 0.720f);
    p.textDisabled = rgba(0.471f, 0.502f, 0.549f);

    p.button = rgba(0.149f, 0.176f, 0.220f);
    p.buttonHovered = rgba(0.184f, 0.224f, 0.275f);
    p.buttonActive = rgba(0.216f, 0.259f, 0.318f);
    p.frameBg = rgba(0.129f, 0.149f, 0.184f);
    p.frameHovered = rgba(0.165f, 0.192f, 0.235f);
    p.frameActive = rgba(0.192f, 0.224f, 0.271f);

    p.codeBg = rgba(0.055f, 0.065f, 0.085f);
    p.proseBg = rgba(0.085f, 0.100f, 0.130f);
    p.proseText = rgba(0.780f, 0.820f, 0.880f);

    p.statusOk = rgba(0.459f, 0.859f, 0.549f);
    p.statusWarn = rgba(0.953f, 0.761f, 0.420f);
    p.statusErr = rgba(0.961f, 0.549f, 0.420f);
    p.statusInfo = rgba(0.451f, 0.741f, 0.961f);
    p.statusPending = rgba(0.600f, 0.660f, 0.740f);
    p.statusOkWash = withAlpha(p.statusOk, 0.16f);
    p.statusWarnWash = withAlpha(p.statusWarn, 0.16f);
    p.statusErrWash = withAlpha(p.statusErr, 0.16f);
    p.statusInfoWash = withAlpha(p.statusInfo, 0.16f);
    p.statusPendingWash = withAlpha(p.statusPending, 0.16f);

    p.diffAdd = p.statusOk;
    p.diffDelete = rgba(0.961f, 0.502f, 0.502f);
    p.diffHunk = p.statusInfo;
    p.diffHeader = rgba(0.600f, 0.660f, 0.740f);
    p.diffAddWash = withAlpha(p.diffAdd, 0.14f);
    p.diffDeleteWash = withAlpha(p.diffDelete, 0.14f);
    p.diffHunkWash = withAlpha(p.diffHunk, 0.12f);

    p.editorGutterBg = rgba(0.067f, 0.075f, 0.094f);
    p.editorGutterText = rgba(0.390f, 0.430f, 0.495f);
    p.editorLineHighlight = rgba(0.145f, 0.165f, 0.205f, 0.52f);
    p.editorCurrentLine = rgba(0.200f, 0.230f, 0.285f, 0.78f);

    p.terminalBackground = p.codeBg;
    p.terminalForeground = p.proseText;
    p.terminalAnsi = {rgb8(33, 38, 48),   rgb8(232, 92, 92),  rgb8(91, 190, 112),
                      rgb8(226, 181, 93), rgb8(91, 150, 226), rgb8(190, 113, 220),
                      rgb8(72, 181, 192), rgb8(210, 216, 225), rgb8(96, 105, 120),
                      rgb8(255, 116, 116), rgb8(120, 221, 139), rgb8(250, 207, 115),
                      rgb8(121, 177, 255), rgb8(219, 147, 247), rgb8(103, 213, 224),
                      rgb8(245, 247, 250)};

    p.glassBg = rgba(0.118f, 0.133f, 0.167f, 0.87f);
    p.glassBorder = rgba(0.230f, 0.275f, 0.365f, 0.80f);
    p.glassHighlight = rgba(1.0f, 1.0f, 1.0f, 0.09f);
    p.glassShadow = rgba(0.0f, 0.0f, 0.0f, 0.40f);
    p.glassText = rgba(0.970f, 0.980f, 0.995f);
    p.glassTextDim = rgba(0.735f, 0.770f, 0.825f);
    p.glassRow = rgba(0.180f, 0.205f, 0.255f, 0.46f);
    p.glassCard = rgba(0.135f, 0.155f, 0.195f, 0.72f);

    p.gaugeTrack = rgba(0.165f, 0.184f, 0.227f, 0.55f);
    p.gaugeSecondary = p.statusInfo;
    p.gaugeOverflow = p.statusErr;

    p.scrollPillTrack = rgba(0.300f, 0.335f, 0.390f, 0.28f);
    p.scrollPillThumb = rgba(0.510f, 0.555f, 0.620f, 0.70f);
    p.scrollPillHovered = rgba(0.650f, 0.700f, 0.770f, 0.82f);
    p.scrollPillActive = rgba(0.760f, 0.805f, 0.870f, 0.92f);

    p.tabStripBg = rgba(0.070f, 0.079f, 0.098f);
    p.tabBg = p.headerBg;
    p.tabHovered = p.buttonHovered;
    p.tabActive = p.panelBg;

    p.diagnosticError = p.statusErr;
    p.diagnosticWarn = p.statusWarn;
    p.diagnosticHint = p.statusInfo;
    p.rule = rgba(0.165f, 0.184f, 0.227f, 0.62f);
    p.disabledWash = withAlpha(p.panelBg, 0.55f);
    return p;
}

Palette lightPalette() {
    Palette p{};
    p.windowBg = rgb8(246, 247, 249);
    p.panelBg = rgb8(255, 255, 255);
    p.headerBg = rgb8(236, 239, 243);
    p.popupBg = rgb8(255, 255, 255);
    p.statusBg = rgb8(238, 241, 245);
    p.border = rgb8(196, 202, 211, 0.90f);
    p.borderStrong = rgb8(151, 160, 173, 0.95f);
    p.shadow = rgba(0.055f, 0.071f, 0.098f, 0.22f);

    p.text = rgb8(31, 36, 48);
    p.textDim = rgb8(83, 92, 108);
    p.textDisabled = rgb8(128, 136, 148);

    p.button = rgb8(229, 233, 239);
    p.buttonHovered = rgb8(217, 223, 232);
    p.buttonActive = rgb8(204, 212, 224);
    p.frameBg = rgb8(239, 242, 246);
    p.frameHovered = rgb8(226, 232, 240);
    p.frameActive = rgb8(214, 222, 233);

    p.codeBg = rgb8(242, 244, 247);
    p.proseBg = rgb8(249, 250, 252);
    p.proseText = rgb8(48, 56, 70);

    p.statusOk = rgb8(37, 142, 69);
    p.statusWarn = rgb8(174, 113, 10);
    p.statusErr = rgb8(196, 65, 49);
    p.statusInfo = rgb8(29, 105, 177);
    p.statusPending = rgb8(99, 109, 124);
    p.statusOkWash = withAlpha(p.statusOk, 0.13f);
    p.statusWarnWash = withAlpha(p.statusWarn, 0.13f);
    p.statusErrWash = withAlpha(p.statusErr, 0.13f);
    p.statusInfoWash = withAlpha(p.statusInfo, 0.13f);
    p.statusPendingWash = withAlpha(p.statusPending, 0.13f);

    p.diffAdd = p.statusOk;
    p.diffDelete = p.statusErr;
    p.diffHunk = p.statusInfo;
    p.diffHeader = rgb8(91, 101, 117);
    p.diffAddWash = withAlpha(p.diffAdd, 0.12f);
    p.diffDeleteWash = withAlpha(p.diffDelete, 0.11f);
    p.diffHunkWash = withAlpha(p.diffHunk, 0.10f);

    p.editorGutterBg = rgb8(239, 242, 246);
    p.editorGutterText = rgb8(133, 142, 155);
    p.editorLineHighlight = rgba(0.240f, 0.320f, 0.430f, 0.08f);
    p.editorCurrentLine = rgba(0.180f, 0.270f, 0.400f, 0.13f);

    p.terminalBackground = rgb8(248, 249, 251);
    p.terminalForeground = rgb8(35, 41, 52);
    p.terminalAnsi = {rgb8(28, 32, 40),    rgb8(181, 49, 49),   rgb8(31, 132, 59),
                      rgb8(154, 104, 14),  rgb8(42, 101, 181),  rgb8(142, 72, 170),
                      rgb8(28, 130, 142),  rgb8(195, 200, 208), rgb8(104, 112, 124),
                      rgb8(215, 75, 75),   rgb8(49, 158, 78),   rgb8(184, 132, 28),
                      rgb8(66, 126, 207),  rgb8(168, 97, 196),  rgb8(47, 154, 166),
                      rgb8(249, 250, 252)};

    p.glassBg = rgba(0.955f, 0.965f, 0.980f, 0.86f);
    p.glassBorder = rgba(0.420f, 0.470f, 0.550f, 0.48f);
    p.glassHighlight = rgba(1.0f, 1.0f, 1.0f, 0.72f);
    p.glassShadow = rgba(0.070f, 0.090f, 0.120f, 0.22f);
    p.glassText = rgb8(24, 29, 39);
    p.glassTextDim = rgb8(75, 84, 99);
    p.glassRow = rgba(0.780f, 0.810f, 0.860f, 0.42f);
    p.glassCard = rgba(0.970f, 0.978f, 0.990f, 0.76f);

    p.gaugeTrack = rgba(0.310f, 0.345f, 0.400f, 0.28f);
    p.gaugeSecondary = p.statusInfo;
    p.gaugeOverflow = p.statusErr;

    p.scrollPillTrack = rgba(0.250f, 0.285f, 0.340f, 0.20f);
    p.scrollPillThumb = rgba(0.360f, 0.400f, 0.470f, 0.55f);
    p.scrollPillHovered = rgba(0.285f, 0.330f, 0.405f, 0.70f);
    p.scrollPillActive = rgba(0.215f, 0.265f, 0.345f, 0.82f);

    p.tabStripBg = rgb8(232, 235, 240);
    p.tabBg = p.headerBg;
    p.tabHovered = p.buttonHovered;
    p.tabActive = p.panelBg;

    p.diagnosticError = p.statusErr;
    p.diagnosticWarn = p.statusWarn;
    p.diagnosticHint = p.statusInfo;
    p.rule = rgb8(183, 190, 201, 0.72f);
    p.disabledWash = withAlpha(p.panelBg, 0.58f);
    return p;
}

void installAccent(Palette& p, Theme value) {
    p.accentAlphas = accentAlphas(value);
    p.accent = withAlpha(gPrimary, 1.0f);
    p.accentDim = dimRgb(p.accent);
    p.secondary = withAlpha(gSecondary, 1.0f);
    p.secondaryDim = dimRgb(p.secondary);
    p.accentSoft = withAlpha(p.accent, p.accentAlphas.soft);
    p.accentMid = withAlpha(p.accent, p.accentAlphas.mid);
    p.accentSelection = withAlpha(p.accent, p.accentAlphas.selection);
    p.accentHover = withAlpha(p.accent, p.accentAlphas.hover);
    p.accentOverlayBorder = withAlpha(p.accent, p.accentAlphas.overlayBorder);
    p.accentChip = withAlpha(p.accent, p.accentAlphas.chip);
    p.accentTreeHover = withAlpha(p.accent, p.accentAlphas.treeHover);
    p.textOnAccent = contrastText(p.accent);
    p.searchMatch = withAlpha(p.secondary, p.accentAlphas.hover);
    p.searchCurrent = p.accentSelection;
    p.terminalSelection = p.accentSelection;
    p.graphNeutral = p.textDim;
    p.graphAccent = p.accent;
    p.graphOk = p.statusOk;
    p.graphWarn = p.statusWarn;
    p.graphErr = p.statusErr;
    p.graphInfo = p.statusInfo;
    p.glassSelectionGlow = p.accentOverlayBorder;
    p.gaugeFill = p.accent;
    p.tabUnderline = p.accent;
    p.focusRing = withAlpha(p.accent, 0.82f);
    p.consoleDefault = p.terminalForeground;
    p.consoleOk = p.statusOk;
    p.consoleWarn = p.statusWarn;
    p.consoleErr = p.statusErr;
    p.consoleDim = p.textDim;
    IM_ASSERT(p.accentAlphas.selection > p.accentAlphas.hover);
}

void mapStyleColors(ImGuiStyle& style, const Palette& p) {
    ImVec4* c = style.Colors;
    c[ImGuiCol_Text] = p.text;
    c[ImGuiCol_TextDisabled] = p.textDisabled;
    c[ImGuiCol_WindowBg] = p.windowBg;
    c[ImGuiCol_ChildBg] = p.panelBg;
    c[ImGuiCol_PopupBg] = p.popupBg;
    c[ImGuiCol_Border] = p.border;
    c[ImGuiCol_BorderShadow] = p.shadow;
    c[ImGuiCol_FrameBg] = p.frameBg;
    c[ImGuiCol_FrameBgHovered] = p.frameHovered;
    c[ImGuiCol_FrameBgActive] = p.frameActive;
    c[ImGuiCol_TitleBg] = p.headerBg;
    c[ImGuiCol_TitleBgActive] = p.headerBg;
    c[ImGuiCol_TitleBgCollapsed] = p.headerBg;
    c[ImGuiCol_MenuBarBg] = p.headerBg;
    c[ImGuiCol_ScrollbarBg] = p.scrollPillTrack;
    c[ImGuiCol_ScrollbarGrab] = p.scrollPillThumb;
    c[ImGuiCol_ScrollbarGrabHovered] = p.scrollPillHovered;
    c[ImGuiCol_ScrollbarGrabActive] = p.scrollPillActive;
    c[ImGuiCol_CheckMark] = p.accent;
    c[ImGuiCol_SliderGrab] = p.accentDim;
    c[ImGuiCol_SliderGrabActive] = p.accent;
    c[ImGuiCol_Button] = p.button;
    c[ImGuiCol_ButtonHovered] = p.buttonHovered;
    c[ImGuiCol_ButtonActive] = p.buttonActive;
    c[ImGuiCol_Header] = p.accentSoft;
    c[ImGuiCol_HeaderHovered] = p.accentHover;
    c[ImGuiCol_HeaderActive] = p.accentSelection;
    c[ImGuiCol_Separator] = p.border;
    c[ImGuiCol_SeparatorHovered] = p.accentHover;
    c[ImGuiCol_SeparatorActive] = p.accent;
    c[ImGuiCol_ResizeGrip] = p.accentSoft;
    c[ImGuiCol_ResizeGripHovered] = p.accentHover;
    c[ImGuiCol_ResizeGripActive] = p.accent;
    c[ImGuiCol_TabHovered] = p.tabHovered;
    c[ImGuiCol_Tab] = p.tabBg;
    c[ImGuiCol_TabSelected] = p.tabActive;
    c[ImGuiCol_TabSelectedOverline] = p.tabUnderline;
    c[ImGuiCol_TabDimmed] = p.tabStripBg;
    c[ImGuiCol_TabDimmedSelected] = p.tabBg;
    c[ImGuiCol_TabDimmedSelectedOverline] = p.accentDim;
    c[ImGuiCol_DockingPreview] = p.accentSelection;
    c[ImGuiCol_DockingEmptyBg] = p.windowBg;
    c[ImGuiCol_PlotLines] = p.textDim;
    c[ImGuiCol_PlotLinesHovered] = p.accent;
    c[ImGuiCol_PlotHistogram] = p.secondary;
    c[ImGuiCol_PlotHistogramHovered] = p.accent;
    c[ImGuiCol_TableHeaderBg] = p.headerBg;
    c[ImGuiCol_TableBorderStrong] = p.borderStrong;
    c[ImGuiCol_TableBorderLight] = p.border;
    c[ImGuiCol_TableRowBg] = withAlpha(p.panelBg, 0.0f);
    c[ImGuiCol_TableRowBgAlt] = withAlpha(p.headerBg, 0.32f);
    c[ImGuiCol_TextLink] = p.secondary;
    c[ImGuiCol_TextSelectedBg] = p.accentSelection;
    c[ImGuiCol_DragDropTarget] = p.accent;
    c[ImGuiCol_NavCursor] = p.focusRing;
    c[ImGuiCol_NavWindowingHighlight] = p.accentHover;
    c[ImGuiCol_NavWindowingDimBg] = withAlpha(p.windowBg, 0.68f);
    c[ImGuiCol_ModalWindowDimBg] = withAlpha(p.windowBg, 0.74f);
}

void setStyleMetrics(ImGuiStyle& style, Theme value) {
    style.WindowRounding = 9.0f;
    style.ChildRounding = 9.0f;
    style.FrameRounding = 7.0f;
    style.PopupRounding = 8.0f;
    style.ScrollbarRounding = 10.0f;
    style.GrabRounding = 7.0f;
    style.TabRounding = 8.0f;
    style.WindowPadding = {15.0f, 13.0f};
    style.FramePadding = {12.0f, 7.0f};
    style.ItemSpacing = {10.0f, 9.0f};
    style.ItemInnerSpacing = {8.0f, 6.0f};
    style.CellPadding = {8.0f, 6.0f};
    style.ScrollbarSize = 12.0f;
    style.GrabMinSize = 11.0f;
    style.WindowBorderSize = 1.0f;
    style.ChildBorderSize = 1.0f;
    style.PopupBorderSize = 1.0f;
    style.FrameBorderSize = value == Theme::Light ? 1.0f : 0.0f;
    style.TabBorderSize = 0.0f;
    style.DisabledAlpha = 0.45f;
}

}  // namespace

namespace metrics {
float scale() { return gScale; }
float px(float logical) { return logical * gScale; }
float U(float units) { return units * kGrid * gScale; }
float stroke(float logical) { return std::max(1.0f, logical * gScale); }
float rounding(float logical) { return std::max(1.0f, logical * gScale); }
}  // namespace metrics

const Palette& palette() { return gPalette; }
const Fonts& fonts() { return gFonts; }
const Radii& radii() { return gRadii; }
Theme theme() { return gTheme; }
float uiScale() { return gScale; }

AccentAlphas accentAlphas(Theme value) {
    if (value == Theme::Light) return {0.18f, 0.35f, 0.40f, 0.35f, 0.40f, 0.22f, 0.08f};
    return {0.22f, 0.40f, 0.50f, 0.40f, 0.275f, 0.30f, 0.10f};
}

std::pair<ImVec4, ImVec4> accentColors() { return {gPrimary, gSecondary}; }

void applyTheme(Theme value, float scale) {
    gTheme = value;
    gScale = std::max(0.25f, scale);
    gPalette = value == Theme::Dark ? darkPalette() : lightPalette();
    installAccent(gPalette, value);

    if (ImGui::GetCurrentContext() == nullptr) return;
    ImGuiStyle& style = ImGui::GetStyle();
    style = ImGuiStyle{};
    setStyleMetrics(style, value);
    mapStyleColors(style, gPalette);
    style.ScaleAllSizes(gScale);
    style.WindowBorderSize = metrics::stroke();
    style.ChildBorderSize = metrics::stroke();
    style.PopupBorderSize = metrics::stroke();
    style.FrameBorderSize = value == Theme::Light ? metrics::stroke() : 0.0f;
    gRadii = {style.WindowRounding, style.ChildRounding, style.FrameRounding,
              style.PopupRounding, style.ScrollbarRounding, style.GrabRounding,
              style.TabRounding};
}

void setAccentColors(ImVec4 primary, ImVec4 secondary) {
    primary.w = 1.0f;
    secondary.w = 1.0f;
    gPrimary = primary;
    gSecondary = secondary;
    if (ImGui::GetCurrentContext() != nullptr) {
        applyTheme(gTheme, gScale);
    } else {
        gPalette = gTheme == Theme::Dark ? darkPalette() : lightPalette();
        installAccent(gPalette, gTheme);
    }
}

bool loadFonts(const char* assetsDir, float scale) {
    if (ImGui::GetCurrentContext() == nullptr || assetsDir == nullptr) return false;

    const float fontScale = std::max(0.25f, scale);
    const std::filesystem::path root = std::filesystem::path(assetsDir) / "fonts";
    static constexpr ImWchar ranges[] = {0x0020, 0x00FF, 0x2010, 0x2027,
                                         0x2070, 0x209F, 0};

    ImGuiIO& io = ImGui::GetIO();
    io.Fonts->Clear();
    const auto add = [&](const char* file, float size) -> ImFont* {
        const std::filesystem::path path = root / file;
        if (!std::filesystem::is_regular_file(path)) return nullptr;
        return io.Fonts->AddFontFromFileTTF(path.string().c_str(), size * fontScale, nullptr, ranges);
    };

    gFonts.body = add("Rubik-Regular.ttf", 17.5f);
    gFonts.medium = add("Rubik-Medium.ttf", 17.5f);
    gFonts.h1 = add("Rubik-Bold.ttf", 30.0f);
    gFonts.h2 = add("Rubik-SemiBold.ttf", 19.0f);
    gFonts.mono = add("JetBrainsMono-Regular.ttf", 15.5f);

    const bool complete = gFonts.body && gFonts.medium && gFonts.h1 && gFonts.h2 && gFonts.mono;
    if (gFonts.body == nullptr) {
        ImFontConfig fallback{};
        fallback.SizePixels = 17.5f * fontScale;
        gFonts.body = io.Fonts->AddFontDefault(&fallback);
    }
    if (gFonts.medium == nullptr) gFonts.medium = gFonts.body;
    if (gFonts.h1 == nullptr) gFonts.h1 = gFonts.body;
    if (gFonts.h2 == nullptr) gFonts.h2 = gFonts.body;
    if (gFonts.mono == nullptr) gFonts.mono = gFonts.body;
    return complete;
}

ImVec4 withAlpha(ImVec4 color, float alpha) {
    color.w = std::clamp(alpha, 0.0f, 1.0f);
    return color;
}

ImU32 toU32(ImVec4 color) { return ImGui::ColorConvertFloat4ToU32(color); }

ImVec4 mix(ImVec4 a, ImVec4 b, float amount) {
    const float t = std::clamp(amount, 0.0f, 1.0f);
    return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t};
}

float luminance(ImVec4 color) {
    const auto linear = [](float value) {
        return value <= 0.04045f ? value / 12.92f
                                 : std::pow((value + 0.055f) / 1.055f, 2.4f);
    };
    return 0.2126f * linear(color.x) + 0.7152f * linear(color.y) +
           0.0722f * linear(color.z);
}

ImVec4 contrastText(ImVec4 surface) {
    return luminance(surface) > 0.38f ? rgba(0.055f, 0.065f, 0.085f)
                                     : rgba(0.970f, 0.980f, 0.995f);
}

}  // namespace chud::ui
