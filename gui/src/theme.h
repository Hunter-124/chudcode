#pragma once

#include "imgui.h"

namespace omp::ui {

struct Palette {
    ImVec4 windowBg;
    ImVec4 panelBg;
    ImVec4 headerBg;
    ImVec4 popupBg;
    ImVec4 border;
    ImVec4 text;
    ImVec4 textDim;
    ImVec4 textDisabled;

    ImVec4 button;
    ImVec4 buttonHovered;
    ImVec4 buttonActive;
    ImVec4 frameBg;
    ImVec4 frameBgHovered;
    ImVec4 frameBgActive;

    ImVec4 codeBg;
    ImVec4 proseBg;
    ImVec4 proseText;
    ImVec4 statusOk;
    ImVec4 warning;
    ImVec4 error;
    ImVec4 diffAdd;
    ImVec4 diffDelete;
    ImVec4 diffHunk;
    ImVec4 diffHeader;

    ImVec4 glassBg;
    ImVec4 glassBorder;
    ImVec4 glassHighlight;
    ImVec4 glassShadow;

    ImVec4 primary;
    ImVec4 primaryDim;
    ImVec4 secondary;
    ImVec4 secondaryDim;
    ImVec4 accentSoft;
    ImVec4 accentMid;
    ImVec4 accentSelection;
    ImVec4 accentHover;
    ImVec4 accentOverlayBorder;
    ImVec4 accentChip;
    ImVec4 accentTreeHover;
    ImVec4 transparent;
};

const Palette& palette();
void setAccentColors(ImVec4 primary, ImVec4 secondary);
void applyTheme(float uiScale);

}  // namespace omp::ui
