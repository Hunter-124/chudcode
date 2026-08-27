#include "kit.h"

#include "theme.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdio>

namespace omp::ui::kit {
namespace {

constexpr int kMaxStackDepth = 16;
std::array<Density, kMaxStackDepth> gDensityStack{};
int gDensityDepth = 0;

struct CardFrame {
    ImDrawListSplitter splitter;
    ImDrawList* drawList = nullptr;
    ImVec2 topLeft{};
    float width = 0.0F;
    ImVec4 tint{};
};

std::array<CardFrame, 8> gCards{};
int gCardDepth = 0;

ImU32 colorU32(const ImVec4& color) {
    return ImGui::ColorConvertFloat4ToU32(color);
}

ImVec4 toneColor(Tone tone) {
    const Palette& p = palette();
    switch (tone) {
        case Tone::Accent: return p.primary;
        case Tone::Positive: return p.statusOk;
        case Tone::Warning: return p.warning;
        case Tone::Danger: return p.error;
        case Tone::Info: return p.secondary;
        case Tone::Neutral: return p.textDim;
    }
    return p.textDim;
}

float rowHeight() {
    return ImGui::GetTextLineHeight() * (density() == Density::Compact ? 2.0F : 2.35F);
}

void pushButtonColors(const ImVec4& normal, const ImVec4& hovered, const ImVec4& active) {
    ImGui::PushStyleColor(ImGuiCol_Button, normal);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, hovered);
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, active);
}

}  // namespace

DensityScope::DensityScope(Density value) {
    assert(gDensityDepth < kMaxStackDepth);
    gDensityStack[gDensityDepth++] = value;
}

DensityScope::~DensityScope() {
    assert(gDensityDepth > 0);
    --gDensityDepth;
}

Density density() {
    return gDensityDepth == 0 ? Density::Cozy : gDensityStack[gDensityDepth - 1];
}

float densityScale() {
    switch (density()) {
        case Density::Compact: return 0.82F;
        case Density::Cozy: return 1.0F;
        case Density::Roomy: return 1.24F;
    }
    return 1.0F;
}

bool cardBegin(const char* id, const char* title, bool* open, const ImVec4* tint) {
    assert(gCardDepth < static_cast<int>(gCards.size()));
    CardFrame& card = gCards[gCardDepth++];
    card.drawList = ImGui::GetWindowDrawList();
    card.topLeft = ImGui::GetCursorScreenPos();
    card.width = std::max(ImGui::GetContentRegionAvail().x, 1.0F);
    card.tint = tint != nullptr ? *tint : palette().glassBg;

    ImGui::PushID(id);
    card.splitter.Split(card.drawList, 2);
    card.splitter.SetCurrentChannel(card.drawList, 1);
    ImGui::SetCursorScreenPos({card.topLeft.x + 12.0F * densityScale(),
                               card.topLeft.y + 10.0F * densityScale()});
    ImGui::BeginGroup();

    bool visible = open == nullptr || *open;
    if (title != nullptr) {
        ImGui::PushStyleColor(ImGuiCol_Text, palette().text);
        if (open != nullptr) {
            ImGui::Checkbox("##open", open);
            visible = *open;
            ImGui::SameLine();
        }
        ImGui::TextUnformatted(title);
        ImGui::PopStyleColor();
        if (visible) {
            ImGui::Dummy({0.0F, 2.0F * densityScale()});
        }
    }
    return visible;
}

void cardEnd() {
    assert(gCardDepth > 0);
    CardFrame& card = gCards[--gCardDepth];
    ImGui::EndGroup();
    const ImVec2 contentMax = ImGui::GetItemRectMax();
    const float pad = 10.0F * densityScale();
    const ImVec2 bottomRight{card.topLeft.x + card.width, contentMax.y + pad};

    card.splitter.SetCurrentChannel(card.drawList, 0);
    card.drawList->AddRectFilled(card.topLeft, bottomRight, colorU32(card.tint),
                                 ImGui::GetStyle().ChildRounding);
    card.drawList->AddRect(card.topLeft, bottomRight, colorU32(palette().glassBorder),
                           ImGui::GetStyle().ChildRounding, 0, 1.0F);
    card.drawList->AddLine({card.topLeft.x + ImGui::GetStyle().ChildRounding, card.topLeft.y + 1.0F},
                           {bottomRight.x - ImGui::GetStyle().ChildRounding, card.topLeft.y + 1.0F},
                           colorU32(palette().glassHighlight));
    card.splitter.Merge(card.drawList);

    // The card content was inset with an absolute cursor move; restore normal flow.
    ImGui::SetCursorScreenPos({card.topLeft.x, bottomRight.y});
    ImGui::Dummy({card.width, 0.0F});
    ImGui::PopID();
}

void cardHeaderRight(float width) {
    const float right = ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x;
    ImGui::SameLine();
    ImGui::SetCursorPosX(std::max(ImGui::GetCursorPosX(), right - width));
}

void sectionHeader(const char* label, const char* trailing, int count, bool first) {
    if (!first) {
        ImGui::Dummy({0.0F, 5.0F * densityScale()});
    }
    ImGui::PushStyleColor(ImGuiCol_Text, palette().textDim);
    ImGui::TextUnformatted(label);
    if (count >= 0 || trailing != nullptr) {
        std::string right;
        if (count >= 0) {
            right = fmtCount(count);
        }
        if (trailing != nullptr) {
            if (!right.empty()) right += "  ";
            right += trailing;
        }
        const float rightWidth = ImGui::CalcTextSize(right.c_str()).x;
        cardHeaderRight(rightWidth);
        ImGui::TextUnformatted(right.c_str());
    }
    ImGui::PopStyleColor();
    rule();
}

bool row(const char* id, const char* title, const RowStyle& style) {
    ImGui::BeginDisabled(style.disabled);
    const ImVec2 start = ImGui::GetCursorScreenPos();
    const ImVec2 size{ImGui::GetContentRegionAvail().x, rowHeight()};
    ImGui::InvisibleButton(id, size);
    const bool pressed = ImGui::IsItemClicked();
    const bool hovered = ImGui::IsItemHovered();
    const ImVec2 after = ImGui::GetCursorScreenPos();
    ImDrawList* draw = ImGui::GetWindowDrawList();

    if (style.selected || hovered) {
        draw->AddRectFilled(start, {start.x + size.x, start.y + size.y},
                            colorU32(style.selected ? palette().accentSoft : palette().accentTreeHover),
                            ImGui::GetStyle().FrameRounding);
    }
    draw->AddRectFilled({start.x + 2.0F, start.y + 5.0F},
                        {start.x + 5.0F, start.y + size.y - 5.0F},
                        colorU32(toneColor(style.tone)), 2.0F);
    const ImVec2 textPos{start.x + 13.0F, start.y + 5.0F};
    draw->AddText(textPos, colorU32(style.disabled ? palette().textDisabled : palette().text), title);
    if (style.secondary != nullptr) {
        draw->AddText({textPos.x, textPos.y + ImGui::GetTextLineHeight()},
                      colorU32(palette().textDim), style.secondary);
    }
    if (style.meta != nullptr) {
        const float metaWidth = ImGui::CalcTextSize(style.meta).x;
        draw->AddText({start.x + size.x - metaWidth - style.actionWidth - 8.0F, textPos.y},
                      colorU32(palette().textDim), style.meta);
    }
    if (hovered && style.tooltip != nullptr) {
        ImGui::SetTooltip("%s", style.tooltip);
    }
    ImGui::SetCursorScreenPos(after);
    ImGui::EndDisabled();
    return pressed;
}

bool chip(const char* id, const char* label, Tone tone, bool selected, const char* tooltip) {
    ImGui::PushID(id);
    const ImVec2 start = ImGui::GetCursorScreenPos();
    const ImVec2 textSize = ImGui::CalcTextSize(label);
    const ImVec2 size{textSize.x + 18.0F, textSize.y + 9.0F};
    ImGui::InvisibleButton("##chip", size);
    const bool pressed = ImGui::IsItemClicked();
    const bool hovered = ImGui::IsItemHovered();
    const ImVec2 after = ImGui::GetCursorScreenPos();
    const ImVec4 fill = selected ? palette().accentChip
                                 : (hovered ? palette().frameBgHovered : palette().frameBg);
    ImDrawList* draw = ImGui::GetWindowDrawList();
    draw->AddRectFilled(start, {start.x + size.x, start.y + size.y}, colorU32(fill), size.y * 0.5F);
    draw->AddRect(start, {start.x + size.x, start.y + size.y}, colorU32(toneColor(tone)),
                  size.y * 0.5F);
    draw->AddText({start.x + 9.0F, start.y + 4.0F}, colorU32(palette().text), label);
    if (hovered && tooltip != nullptr) {
        ImGui::SetTooltip("%s", tooltip);
    }
    ImGui::SetCursorScreenPos(after);
    ImGui::PopID();
    return pressed;
}

bool primaryButton(const char* label, const ImVec2& size) {
    pushButtonColors(palette().primaryDim, palette().primary, palette().accentMid);
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor(3);
    return pressed;
}

bool secondaryButton(const char* label, const ImVec2& size) {
    pushButtonColors(palette().button, palette().buttonHovered, palette().buttonActive);
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor(3);
    return pressed;
}

bool iconButton(const char* id, const char* asciiLabel, const char* tooltip, const ImVec2& size) {
    assert(tooltip != nullptr && tooltip[0] != '\0');
    ImGui::PushID(id);
    const bool pressed = secondaryButton(asciiLabel, size);
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip("%s", tooltip);
    }
    ImGui::PopID();
    return pressed;
}

void statusGlyph(Tone tone, float diameter) {
    const ImVec2 start = ImGui::GetCursorScreenPos();
    ImGui::Dummy({diameter, diameter});
    ImGui::GetWindowDrawList()->AddCircleFilled(
        {start.x + diameter * 0.5F, start.y + diameter * 0.5F}, diameter * 0.5F,
        colorU32(toneColor(tone)), 16);
}

void progressBar(float fraction, const ImVec2& size, const char* overlay) {
    ImGui::PushStyleColor(ImGuiCol_PlotHistogram, palette().primary);
    ImGui::PushStyleColor(ImGuiCol_FrameBg, palette().frameBg);
    ImGui::ProgressBar(std::clamp(fraction, 0.0F, 1.0F), size, overlay);
    ImGui::PopStyleColor(2);
}

void spinner(const char* id, float radius, float thickness) {
    ImGui::PushID(id);
    const ImVec2 start = ImGui::GetCursorScreenPos();
    const ImVec2 size{radius * 2.0F, radius * 2.0F};
    ImGui::InvisibleButton("##spinner", size);
    const ImVec2 center{start.x + radius, start.y + radius};
    ImDrawList* draw = ImGui::GetWindowDrawList();
    constexpr int segments = 24;
    const float phase = static_cast<float>(ImGui::GetTime() * 4.5);
    const float pi = 3.14159265358979323846F;
    draw->PathClear();
    for (int i = 0; i < segments * 3 / 4; ++i) {
        const float angle = phase + (static_cast<float>(i) / segments) * 2.0F * pi;
        draw->PathLineTo({center.x + std::cos(angle) * radius,
                          center.y + std::sin(angle) * radius});
    }
    draw->PathStroke(colorU32(palette().primary), 0, thickness);
    ImGui::PopID();
}

void emptyState(const char* title, const char* detail) {
    ImGui::Dummy({0.0F, 12.0F * densityScale()});
    const float titleWidth = ImGui::CalcTextSize(title).x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0F, (ImGui::GetContentRegionAvail().x - titleWidth) * 0.5F));
    ImGui::TextUnformatted(title);
    if (detail != nullptr) {
        const float detailWidth = ImGui::CalcTextSize(detail).x;
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0F, (ImGui::GetContentRegionAvail().x - detailWidth) * 0.5F));
        dimText(detail);
    }
}

void dimText(const char* text) {
    ImGui::PushStyleColor(ImGuiCol_Text, palette().textDim);
    ImGui::TextUnformatted(text);
    ImGui::PopStyleColor();
}

void keyValueRow(const char* key, const char* value) {
    ImGui::TextUnformatted(key);
    ImGui::SameLine();
    const float width = ImGui::CalcTextSize(value).x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0F, ImGui::GetContentRegionAvail().x - width));
    dimText(value);
}

void rule() {
    const ImVec2 start = ImGui::GetCursorScreenPos();
    const float width = ImGui::GetContentRegionAvail().x;
    ImGui::Dummy({width, 1.0F});
    ImGui::GetWindowDrawList()->AddLine(start, {start.x + width, start.y},
                                        colorU32(palette().border));
}

std::string fmtAgo(std::int64_t secondsAgo) {
    if (secondsAgo < 5) return "now";
    if (secondsAgo < 60) return std::to_string(secondsAgo) + "s ago";
    if (secondsAgo < 3600) return std::to_string(secondsAgo / 60) + "m ago";
    if (secondsAgo < 86400) return std::to_string(secondsAgo / 3600) + "h ago";
    return std::to_string(secondsAgo / 86400) + "d ago";
}

std::string fmtCount(std::int64_t count) {
    char buffer[32];
    if (count >= 1000000) {
        std::snprintf(buffer, sizeof(buffer), "%.1fM", static_cast<double>(count) / 1000000.0);
    } else if (count >= 1000) {
        std::snprintf(buffer, sizeof(buffer), "%.1fk", static_cast<double>(count) / 1000.0);
    } else {
        std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(count));
    }
    return buffer;
}

}  // namespace omp::ui::kit
