#include "theme.h"

#include <algorithm>

namespace omp::ui {
namespace {

Palette gPalette{};
ImVec4 gPrimary{242.0F / 255.0F, 130.0F / 255.0F, 22.0F / 255.0F, 1.0F};
ImVec4 gSecondary{0.0F, 120.0F / 255.0F, 215.0F / 255.0F, 1.0F};

ImVec4 withAlpha(const ImVec4& color, float alpha) {
    return {color.x, color.y, color.z, alpha};
}

ImVec4 dimmed(const ImVec4& color) {
    return {color.x * 0.70F, color.y * 0.70F, color.z * 0.70F, color.w};
}

void deriveAccents() {
    gPalette.primary = gPrimary;
    gPalette.primaryDim = dimmed(gPrimary);
    gPalette.secondary = gSecondary;
    gPalette.secondaryDim = dimmed(gSecondary);
    gPalette.accentSoft = withAlpha(gPrimary, 0.22F);
    gPalette.accentMid = withAlpha(gPrimary, 0.40F);
    gPalette.accentSelection = withAlpha(gPrimary, 0.22F);
    gPalette.accentHover = withAlpha(gPrimary, 0.40F);
    gPalette.accentOverlayBorder = withAlpha(gPrimary, 0.275F);
    gPalette.accentChip = withAlpha(gPrimary, 0.30F);
    gPalette.accentTreeHover = withAlpha(gPrimary, 0.10F);
}

}  // namespace

const Palette& palette() {
    return gPalette;
}

void setAccentColors(ImVec4 primary, ImVec4 secondary) {
    primary.w = 1.0F;
    secondary.w = 1.0F;
    gPrimary = primary;
    gSecondary = secondary;
    deriveAccents();
}

void applyTheme(float uiScale) {
    gPalette.windowBg = {0.082F, 0.090F, 0.110F, 1.0F};
    gPalette.panelBg = {0.094F, 0.106F, 0.129F, 1.0F};
    gPalette.headerBg = {0.110F, 0.125F, 0.157F, 1.0F};
    gPalette.popupBg = {0.106F, 0.118F, 0.145F, 1.0F};
    gPalette.border = {0.165F, 0.184F, 0.227F, 0.85F};
    gPalette.text = {0.898F, 0.918F, 0.945F, 1.0F};
    gPalette.textDim = {0.620F, 0.660F, 0.720F, 1.0F};
    gPalette.textDisabled = {0.471F, 0.502F, 0.549F, 1.0F};

    gPalette.button = {0.149F, 0.176F, 0.220F, 1.0F};
    gPalette.buttonHovered = {0.184F, 0.224F, 0.275F, 1.0F};
    gPalette.buttonActive = {0.216F, 0.259F, 0.318F, 1.0F};
    gPalette.frameBg = {0.129F, 0.149F, 0.184F, 1.0F};
    gPalette.frameBgHovered = {0.165F, 0.192F, 0.235F, 1.0F};
    gPalette.frameBgActive = {0.192F, 0.224F, 0.271F, 1.0F};

    gPalette.codeBg = {0.055F, 0.065F, 0.085F, 1.0F};
    gPalette.proseBg = {0.085F, 0.100F, 0.130F, 1.0F};
    gPalette.proseText = {0.780F, 0.820F, 0.880F, 1.0F};
    gPalette.statusOk = {0.459F, 0.859F, 0.549F, 1.0F};
    gPalette.warning = {0.953F, 0.761F, 0.420F, 1.0F};
    gPalette.error = {0.961F, 0.549F, 0.420F, 1.0F};
    gPalette.diffAdd = {0.459F, 0.859F, 0.549F, 1.0F};
    gPalette.diffDelete = {0.961F, 0.502F, 0.502F, 1.0F};
    gPalette.diffHunk = {0.451F, 0.741F, 0.961F, 1.0F};
    gPalette.diffHeader = {0.600F, 0.660F, 0.740F, 1.0F};

    gPalette.glassBg = {0.118F, 0.133F, 0.167F, 0.87F};
    gPalette.glassBorder = {0.230F, 0.275F, 0.365F, 0.80F};
    gPalette.glassHighlight = {1.0F, 1.0F, 1.0F, 0.09F};
    gPalette.glassShadow = {0.0F, 0.0F, 0.0F, 0.40F};
    gPalette.transparent = {0.0F, 0.0F, 0.0F, 0.0F};
    deriveAccents();

    ImGuiStyle& style = ImGui::GetStyle();
    style = ImGuiStyle{};
    style.WindowRounding = 9.0F;
    style.ChildRounding = 9.0F;
    style.FrameRounding = 7.0F;
    style.PopupRounding = 8.0F;
    style.ScrollbarRounding = 10.0F;
    style.GrabRounding = 7.0F;
    style.TabRounding = 8.0F;
    style.WindowPadding = {15.0F, 13.0F};
    style.FramePadding = {12.0F, 7.0F};
    style.ItemSpacing = {10.0F, 9.0F};
    style.ItemInnerSpacing = {8.0F, 6.0F};
    style.CellPadding = {8.0F, 6.0F};
    style.ScrollbarSize = 12.0F;
    style.GrabMinSize = 11.0F;
    style.WindowBorderSize = 1.0F;
    style.ChildBorderSize = 1.0F;
    style.PopupBorderSize = 1.0F;
    style.FrameBorderSize = 0.0F;
    style.TabBorderSize = 0.0F;
    style.DisabledAlpha = 0.45F;

    ImVec4* colors = style.Colors;
    colors[ImGuiCol_Text] = gPalette.text;
    colors[ImGuiCol_TextDisabled] = gPalette.textDisabled;
    colors[ImGuiCol_WindowBg] = gPalette.windowBg;
    colors[ImGuiCol_ChildBg] = gPalette.panelBg;
    colors[ImGuiCol_PopupBg] = gPalette.popupBg;
    colors[ImGuiCol_Border] = gPalette.border;
    colors[ImGuiCol_BorderShadow] = gPalette.glassShadow;
    colors[ImGuiCol_FrameBg] = gPalette.frameBg;
    colors[ImGuiCol_FrameBgHovered] = gPalette.frameBgHovered;
    colors[ImGuiCol_FrameBgActive] = gPalette.frameBgActive;
    colors[ImGuiCol_TitleBg] = gPalette.headerBg;
    colors[ImGuiCol_TitleBgActive] = gPalette.headerBg;
    colors[ImGuiCol_TitleBgCollapsed] = gPalette.panelBg;
    colors[ImGuiCol_MenuBarBg] = gPalette.headerBg;
    colors[ImGuiCol_ScrollbarBg] = gPalette.windowBg;
    colors[ImGuiCol_ScrollbarGrab] = gPalette.button;
    colors[ImGuiCol_ScrollbarGrabHovered] = gPalette.buttonHovered;
    colors[ImGuiCol_ScrollbarGrabActive] = gPalette.buttonActive;
    colors[ImGuiCol_CheckMark] = gPalette.primary;
    colors[ImGuiCol_SliderGrab] = gPalette.primaryDim;
    colors[ImGuiCol_SliderGrabActive] = gPalette.primary;
    colors[ImGuiCol_Button] = gPalette.button;
    colors[ImGuiCol_ButtonHovered] = gPalette.buttonHovered;
    colors[ImGuiCol_ButtonActive] = gPalette.buttonActive;
    colors[ImGuiCol_Header] = gPalette.accentSoft;
    colors[ImGuiCol_HeaderHovered] = gPalette.accentHover;
    colors[ImGuiCol_HeaderActive] = gPalette.accentMid;
    colors[ImGuiCol_Separator] = gPalette.accentOverlayBorder;
    colors[ImGuiCol_SeparatorHovered] = gPalette.accentHover;
    colors[ImGuiCol_SeparatorActive] = gPalette.primary;
    colors[ImGuiCol_ResizeGrip] = gPalette.accentSoft;
    colors[ImGuiCol_ResizeGripHovered] = gPalette.accentHover;
    colors[ImGuiCol_ResizeGripActive] = gPalette.primary;
    colors[ImGuiCol_TabHovered] = gPalette.accentHover;
    colors[ImGuiCol_Tab] = gPalette.headerBg;
    colors[ImGuiCol_TabSelected] = gPalette.accentMid;
    colors[ImGuiCol_TabSelectedOverline] = gPalette.primary;
    colors[ImGuiCol_TabDimmed] = gPalette.panelBg;
    colors[ImGuiCol_TabDimmedSelected] = gPalette.accentSoft;
    colors[ImGuiCol_DockingPreview] = gPalette.accentSelection;
    colors[ImGuiCol_DockingEmptyBg] = gPalette.windowBg;
    colors[ImGuiCol_PlotLines] = gPalette.secondary;
    colors[ImGuiCol_PlotHistogram] = gPalette.primary;
    colors[ImGuiCol_TableHeaderBg] = gPalette.headerBg;
    colors[ImGuiCol_TableBorderStrong] = gPalette.border;
    colors[ImGuiCol_TableBorderLight] = gPalette.glassBorder;
    colors[ImGuiCol_TableRowBg] = gPalette.transparent;
    colors[ImGuiCol_TableRowBgAlt] = gPalette.glassHighlight;
    colors[ImGuiCol_TextLink] = gPalette.secondary;
    colors[ImGuiCol_TextSelectedBg] = gPalette.accentSelection;
    colors[ImGuiCol_DragDropTarget] = gPalette.primary;
    colors[ImGuiCol_NavCursor] = gPalette.primary;
    colors[ImGuiCol_NavWindowingHighlight] = gPalette.accentHover;
    colors[ImGuiCol_NavWindowingDimBg] = gPalette.glassShadow;
    colors[ImGuiCol_ModalWindowDimBg] = gPalette.glassShadow;

    style.ScaleAllSizes(std::max(uiScale, 0.25F));
}

}  // namespace omp::ui
