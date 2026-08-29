#include "widgets/kit.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <string>

#include "theme/anim.h"

namespace chud::kit {
namespace {

constexpr int kDensityStackCapacity = 16;
constexpr int kRowStackCapacity = 16;

std::array<Density, kDensityStackCapacity> gDensityStack{};
int gDensityDepth = 0;
Density gDensity = Density::Cozy;

struct RowState {
    ImDrawList* drawList = nullptr;
    ImDrawListSplitter splitter;
    ImGuiID id = 0;
    ImVec2 localStart{};
    ImVec2 screenStart{};
    float width = 0.0f;
    float minimumHeight = 0.0f;
    bool hovered = false;
    bool disabled = false;
    bool selected = false;
    const char* tooltip = nullptr;
};

std::array<RowState, kRowStackCapacity> gRows{};
int gRowDepth = 0;

ImVec4 toneWash(Tone tone) {
    const ui::Palette& p = ui::palette();
    switch (tone) {
        case Tone::Accent: return p.accentChip;
        case Tone::Ok: return p.statusOkWash;
        case Tone::Warn: return p.statusWarnWash;
        case Tone::Err: return p.statusErrWash;
        case Tone::Info: return p.statusInfoWash;
        case Tone::Neutral: return p.frameBg;
    }
    return p.frameBg;
}

bool tonedButton(const char* label, ImVec2 size, Tone tone, bool prominent,
                 bool enabled, const char* disabledReason) {
    const ui::Palette& p = ui::palette();
    ImVec4 base = p.button;
    ImVec4 hovered = p.buttonHovered;
    ImVec4 active = p.buttonActive;
    ImVec4 text = p.text;

    if (tone == Tone::Accent) {
        base = prominent ? p.accentDim : p.accentSoft;
        hovered = prominent ? p.accent : p.accentHover;
        active = p.accent;
        text = prominent ? p.textOnAccent : p.text;
    } else if (tone == Tone::Err) {
        base = prominent ? p.statusErr : p.statusErrWash;
        hovered = p.statusErr;
        active = p.statusErr;
        text = prominent ? ui::contrastText(p.statusErr) : p.text;
    }

    ImGui::PushStyleColor(ImGuiCol_Button, base);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, hovered);
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, active);
    ImGui::PushStyleColor(ImGuiCol_Text, text);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, densityMetrics().rowRound);
    ImGui::BeginDisabled(!enabled);
    const bool pressed = ImGui::Button(label, size);
    if (!enabled && disabledReason != nullptr &&
        ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
        ImGui::SetTooltip("%s", disabledReason);
    }
    ImGui::EndDisabled();
    ImGui::PopStyleVar();
    ImGui::PopStyleColor(4);
    return pressed;
}

}  // namespace

ImVec4 toneVec(Tone tone) {
    const ui::Palette& p = ui::palette();
    switch (tone) {
        case Tone::Accent: return p.accent;
        case Tone::Ok: return p.statusOk;
        case Tone::Warn: return p.statusWarn;
        case Tone::Err: return p.statusErr;
        case Tone::Info: return p.statusInfo;
        case Tone::Neutral: return p.textDim;
    }
    return p.textDim;
}

ImU32 toneU32(Tone tone) { return ui::toU32(toneVec(tone)); }

ImVec4 toneOn(Tone tone, ImVec4 surface) {
    const ImVec4 candidate = toneVec(tone);
    const float foreground = ui::luminance(candidate);
    const float background = ui::luminance(surface);
    const float ratio = (std::max(foreground, background) + 0.05f) /
                        (std::min(foreground, background) + 0.05f);
    return ratio >= 4.5f ? candidate : ui::contrastText(surface);
}

Density density() { return gDensity; }

DensityMetrics densityMetrics(Density value) {
    using ui::metrics::px;
    switch (value) {
        case Density::Compact:
            return {px(9.0f), px(4.0f), px(2.0f), px(6.0f), px(9.0f),
                    px(6.0f), px(4.0f), px(8.0f)};
        case Density::Roomy:
            return {px(12.0f), px(10.0f), px(8.0f), px(8.0f), px(14.0f),
                    px(16.0f), px(6.0f), px(12.0f)};
        case Density::Cozy:
            return {px(10.0f), px(8.0f), px(5.0f), px(8.0f), px(12.0f),
                    px(14.0f), px(6.0f), px(10.0f)};
    }
    return {};
}

DensityMetrics densityMetrics() { return densityMetrics(gDensity); }

void pushDensity(Density value) {
    IM_ASSERT(gDensityDepth < kDensityStackCapacity);
    if (gDensityDepth >= kDensityStackCapacity) return;
    gDensityStack[static_cast<std::size_t>(gDensityDepth++)] = gDensity;
    gDensity = value;
}

void popDensity() {
    IM_ASSERT(gDensityDepth > 0);
    if (gDensityDepth <= 0) return;
    gDensity = gDensityStack[static_cast<std::size_t>(--gDensityDepth)];
}

DensityScope::DensityScope(Density value) { pushDensity(value); }
DensityScope::~DensityScope() { popDensity(); }

DrawListSplitScope::DrawListSplitScope(ImDrawList* drawList, int channels)
    : drawList_(drawList), channels_(std::max(1, channels)) {
    if (drawList_ != nullptr && channels_ > 1) splitter_.Split(drawList_, channels_);
}

DrawListSplitScope::~DrawListSplitScope() {
    if (drawList_ != nullptr && channels_ > 1) splitter_.Merge(drawList_);
}

void DrawListSplitScope::channel(int index) {
    IM_ASSERT(index >= 0 && index < channels_);
    if (drawList_ != nullptr && channels_ > 1 && index >= 0 && index < channels_)
        splitter_.SetCurrentChannel(drawList_, index);
}

bool cardBegin(const char* id, const CardOptions& options) {
    const DensityMetrics rhythm = densityMetrics();
    const ui::Palette& p = ui::palette();
    const ImVec4 background = options.tint == Tone::Neutral ? p.panelBg : toneWash(options.tint);

    ImGui::PushStyleColor(ImGuiCol_ChildBg, background);
    ImGui::PushStyleColor(ImGuiCol_Border, options.selected ? p.focusRing : p.border);
    ImGui::PushStyleVar(ImGuiStyleVar_ChildRounding, rhythm.rowRound);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(rhythm.padX, rhythm.padY));
    ImGui::PushStyleVar(ImGuiStyleVar_ChildBorderSize,
                        ui::metrics::stroke(options.selected ? 2.0f : 1.0f));
    const bool visible = ImGui::BeginChild(
        id, ImVec2(0.0f, 0.0f),
        ImGuiChildFlags_Borders | ImGuiChildFlags_AutoResizeY |
            ImGuiChildFlags_AlwaysUseWindowPadding,
        ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
    if (!visible) return false;

    bool expanded = options.open == nullptr || *options.open;
    if (options.title != nullptr) {
        if (options.open != nullptr) {
            const ImVec2 start = ImGui::GetCursorScreenPos();
            const float height = ImGui::GetFrameHeight();
            ImGui::InvisibleButton("##card-disclosure",
                                   ImVec2(ImGui::GetContentRegionAvail().x, height));
            if (ImGui::IsItemClicked()) {
                *options.open = !*options.open;
                expanded = *options.open;
            }

            ImDrawList* drawList = ImGui::GetWindowDrawList();
            const float marker = ui::metrics::U(0.75f);
            const ImVec2 center{start.x + marker, start.y + height * 0.5f};
            if (expanded) {
                drawList->AddTriangleFilled(
                    {center.x - marker * 0.5f, center.y - marker * 0.25f},
                    {center.x + marker * 0.5f, center.y - marker * 0.25f},
                    {center.x, center.y + marker * 0.5f}, ui::toU32(p.textDim));
            } else {
                drawList->AddTriangleFilled(
                    {center.x - marker * 0.25f, center.y - marker * 0.5f},
                    {center.x - marker * 0.25f, center.y + marker * 0.5f},
                    {center.x + marker * 0.5f, center.y}, ui::toU32(p.textDim));
            }
            ImFont* font = ui::fonts().medium != nullptr ? ui::fonts().medium : ImGui::GetFont();
            const float fontSize = ImGui::GetFontSize();
            drawList->AddText(font, fontSize,
                              {start.x + marker + rhythm.headGap,
                               start.y + (height - fontSize) * 0.5f},
                              ui::toU32(p.text), options.title);
        } else {
            ImGui::PushStyleColor(ImGuiCol_Text, p.text);
            if (ui::fonts().medium != nullptr) ImGui::PushFont(ui::fonts().medium);
            ImGui::TextUnformatted(options.title);
            if (ui::fonts().medium != nullptr) ImGui::PopFont();
            ImGui::PopStyleColor();
        }
        if (expanded) ImGui::Dummy(ImVec2(0.0f, rhythm.headGap));
    }
    return expanded;
}

void cardEnd() {
    ImGui::EndChild();
    ImGui::PopStyleVar(3);
    ImGui::PopStyleColor(2);
}

void cardHeaderRight(float width) {
    const DensityMetrics rhythm = densityMetrics();
    const float right = ImGui::GetWindowContentRegionMax().x - rhythm.padX;
    ImGui::SameLine();
    ImGui::SetCursorPosX(std::max(ImGui::GetCursorPosX(), right - width));
}

void sectionHeader(const char* label, const SectionOptions& options) {
    const DensityMetrics rhythm = densityMetrics();
    if (!options.first) ImGui::Dummy(ImVec2(0.0f, rhythm.sectionGap));

    const ui::Palette& p = ui::palette();
    if (ui::fonts().medium != nullptr) ImGui::PushFont(ui::fonts().medium);
    ImGui::PushStyleColor(ImGuiCol_Text, p.text);
    ImGui::TextUnformatted(label);
    ImGui::PopStyleColor();
    if (ui::fonts().medium != nullptr) ImGui::PopFont();

    if (options.count >= 0 || options.trailing != nullptr) {
        char count[32]{};
        const char* trailing = options.trailing;
        if (options.count >= 0) {
            std::snprintf(count, sizeof(count), "%d", options.count);
            trailing = count;
        }
        const float width = ImGui::CalcTextSize(trailing).x;
        ImGui::SameLine();
        ImGui::SetCursorPosX(std::max(ImGui::GetCursorPosX(),
                                     ImGui::GetWindowContentRegionMax().x - width));
        dimText(trailing);
    }
    ImGui::Dummy(ImVec2(0.0f, rhythm.headGap));
}

bool rowBegin(const char* id, const RowStyle& style) {
    IM_ASSERT(gRowDepth < kRowStackCapacity);
    if (gRowDepth >= kRowStackCapacity) return false;

    RowState& state = gRows[static_cast<std::size_t>(gRowDepth++)];
    const DensityMetrics rhythm = densityMetrics();
    state.drawList = ImGui::GetWindowDrawList();
    state.id = ImGui::GetID(id);
    state.localStart = ImGui::GetCursorPos();
    state.screenStart = ImGui::GetCursorScreenPos();
    state.width = std::max(ui::metrics::stroke(), ImGui::GetContentRegionAvail().x);
    state.minimumHeight = style.minimumHeight > 0.0f
                              ? style.minimumHeight
                              : ImGui::GetFrameHeight() + rhythm.padY * 2.0f;
    state.disabled = style.disabled;
    state.selected = style.selected;
    state.tooltip = style.tooltip;

    state.splitter.Split(state.drawList, 2);
    state.splitter.SetCurrentChannel(state.drawList, 1);
    ImGui::SetNextItemAllowOverlap();
    ImGui::InvisibleButton(id, ImVec2(state.width, state.minimumHeight));
    const bool clicked = ImGui::IsItemClicked() && !style.disabled;
    state.hovered = ImGui::IsItemHovered();

    ImGui::SetCursorPos({state.localStart.x + rhythm.padX,
                         state.localStart.y + rhythm.padY});
    ImGui::BeginGroup();
    if (style.disabled) ImGui::BeginDisabled();
    return clicked;
}

void rowEnd() {
    IM_ASSERT(gRowDepth > 0);
    if (gRowDepth <= 0) return;
    RowState& state = gRows[static_cast<std::size_t>(--gRowDepth)];
    const DensityMetrics rhythm = densityMetrics();
    if (state.disabled) ImGui::EndDisabled();
    ImGui::EndGroup();

    const float contentBottom = ImGui::GetItemRectMax().y + rhythm.padY;
    const float bottom = std::max(state.screenStart.y + state.minimumHeight, contentBottom);
    const ImVec2 rectMax{state.screenStart.x + state.width, bottom};
    const ui::Palette& p = ui::palette();
    const float hover = anim::toward(state.id ^ 0x4B495452u,
                                     state.hovered && !state.disabled ? 1.0f : 0.0f,
                                     anim::kFast);

    state.splitter.SetCurrentChannel(state.drawList, 0);
    if (state.selected) {
        state.drawList->AddRectFilled(state.screenStart, rectMax,
                                      ui::toU32(p.accentSelection), rhythm.rowRound);
        state.drawList->AddRect(state.screenStart, rectMax, ui::toU32(p.focusRing),
                                rhythm.rowRound, 0, ui::metrics::stroke(2.0f));
    } else if (hover > 0.0f) {
        state.drawList->AddRectFilled(state.screenStart, rectMax,
                                      ui::toU32(ui::mix(p.panelBg, p.accentHover, hover)),
                                      rhythm.rowRound);
    }
    state.splitter.SetCurrentChannel(state.drawList, 1);
    state.splitter.Merge(state.drawList);

    if (state.tooltip != nullptr && state.hovered) ImGui::SetTooltip("%s", state.tooltip);
    const float logicalHeight = bottom - state.screenStart.y;
    // Reserve the full painted row through a real item. Dear ImGui 1.92 rejects
    // SetCursorPos beyond a child boundary as an implicit window-extension hack.
    ImGui::SetCursorPos(state.localStart);
    ImGui::Dummy({state.width, logicalHeight + rhythm.rowGap});
}

bool row(const char* id, const char* title, const RowStyle& style) {
    RowStyle resolved = style;
    const DensityMetrics rhythm = densityMetrics();
    if (resolved.minimumHeight <= 0.0f && resolved.secondary != nullptr)
        resolved.minimumHeight = ImGui::GetTextLineHeight() * 2.0f + rhythm.padY * 3.0f;

    const bool clicked = rowBegin(id, resolved);
    ImGui::TextUnformatted(title);
    if (resolved.meta != nullptr) {
        const float metaWidth = ImGui::CalcTextSize(resolved.meta).x;
        ImGui::SameLine();
        ImGui::SetCursorPosX(std::max(ImGui::GetCursorPosX(),
                                     ImGui::GetWindowContentRegionMax().x - metaWidth -
                                         resolved.actionsWidth - rhythm.padX));
        dimText(resolved.meta);
    }
    if (resolved.secondary != nullptr) dimText(resolved.secondary);
    rowEnd();
    return clicked;
}

bool chip(const char* label, Tone tone) {
    const ui::Palette& p = ui::palette();
    const ImVec4 background = toneWash(tone);
    ImGui::PushStyleColor(ImGuiCol_Button, background);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered,
                          tone == Tone::Neutral ? p.buttonHovered : toneVec(tone));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,
                          tone == Tone::Neutral ? p.buttonActive : toneVec(tone));
    ImGui::PushStyleColor(ImGuiCol_Text, toneOn(tone, background));
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, densityMetrics().chipRound);
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding,
                        ImVec2(densityMetrics().padX, densityMetrics().padY * 0.5f));
    const bool pressed = ImGui::Button(label);
    ImGui::PopStyleVar(2);
    ImGui::PopStyleColor(4);
    return pressed;
}

bool valueChip(const char* label, const char* value, Tone tone) {
    ImGui::PushID(label);
    ImGui::BeginGroup();
    dimText(label);
    ImGui::SameLine(0.0f, densityMetrics().headGap);
    const bool pressed = chip(value, tone);
    ImGui::EndGroup();
    ImGui::PopID();
    return pressed;
}

bool toggleChip(const char* label, bool* value, Tone tone) {
    IM_ASSERT(value != nullptr);
    if (value == nullptr) return false;
    const ui::Palette& p = ui::palette();
    const float selected = anim::toward(ImGui::GetID(label) ^ 0x544F4747u,
                                        *value ? 1.0f : 0.0f, anim::kFast);
    const ImVec4 background = ui::mix(p.frameBg, toneWash(tone), selected);
    ImGui::PushStyleColor(ImGuiCol_Button, background);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered,
                          ui::mix(p.buttonHovered, toneVec(tone), selected));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, toneVec(tone));
    ImGui::PushStyleColor(ImGuiCol_Text, toneOn(tone, background));
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, densityMetrics().chipRound);
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding,
                        ImVec2(densityMetrics().padX, densityMetrics().padY * 0.5f));
    const bool pressed = ImGui::Button(label);
    ImGui::PopStyleVar(2);
    ImGui::PopStyleColor(4);
    if (pressed) *value = !*value;
    return pressed;
}

bool primaryButton(const char* label, ImVec2 size, bool enabled,
                   const char* disabledReason) {
    return tonedButton(label, size, Tone::Accent, true, enabled, disabledReason);
}

bool secondaryButton(const char* label, ImVec2 size, bool enabled,
                     const char* disabledReason) {
    return tonedButton(label, size, Tone::Neutral, false, enabled, disabledReason);
}

bool dangerButton(const char* label, ImVec2 size, bool enabled,
                  const char* disabledReason) {
    return tonedButton(label, size, Tone::Err, true, enabled, disabledReason);
}

Tone statusTone(Status status) {
    switch (status) {
        case Status::Running: return Tone::Info;
        case Status::Done: return Tone::Ok;
        case Status::Failed: return Tone::Err;
        case Status::Retry: return Tone::Warn;
        case Status::Pending:
        case Status::Skipped: return Tone::Neutral;
    }
    return Tone::Neutral;
}

void statusGlyph(ImDrawList* drawList, ImVec2 center, float radius, Status status) {
    if (drawList == nullptr) return;
    const ImU32 color = toneU32(statusTone(status));
    const float line = ui::metrics::stroke(1.5f);
    constexpr float kPi = 3.14159265359f;

    switch (status) {
        case Status::Pending:
            drawList->AddCircle(center, radius, color, 20, line);
            break;
        case Status::Running: {
            const float start = anim::phase(anim::kMarch) * 2.0f * kPi;
            drawList->PathArcTo(center, radius, start, start + 1.35f * kPi, 20);
            drawList->PathStroke(color, 0, line);
            break;
        }
        case Status::Done:
            drawList->AddLine({center.x - radius * 0.70f, center.y},
                              {center.x - radius * 0.15f, center.y + radius * 0.55f},
                              color, line);
            drawList->AddLine({center.x - radius * 0.15f, center.y + radius * 0.55f},
                              {center.x + radius * 0.75f, center.y - radius * 0.55f},
                              color, line);
            break;
        case Status::Failed:
            drawList->AddLine({center.x - radius * 0.6f, center.y - radius * 0.6f},
                              {center.x + radius * 0.6f, center.y + radius * 0.6f},
                              color, line);
            drawList->AddLine({center.x + radius * 0.6f, center.y - radius * 0.6f},
                              {center.x - radius * 0.6f, center.y + radius * 0.6f},
                              color, line);
            break;
        case Status::Retry:
            drawList->PathArcTo(center, radius, -0.25f * kPi, 1.45f * kPi, 20);
            drawList->PathStroke(color, 0, line);
            drawList->AddTriangleFilled(
                {center.x + radius * 0.9f, center.y - radius * 0.15f},
                {center.x + radius * 0.25f, center.y - radius * 0.30f},
                {center.x + radius * 0.65f, center.y - radius * 0.75f}, color);
            break;
        case Status::Skipped:
            drawList->AddLine({center.x - radius * 0.7f, center.y},
                              {center.x + radius * 0.7f, center.y}, color, line);
            break;
    }
}

void statusGlyphInline(Status status, float size) {
    if (size <= 0.0f) size = ImGui::GetTextLineHeight();
    const ImVec2 start = ImGui::GetCursorScreenPos();
    ImGui::Dummy({size, size});
    statusGlyph(ImGui::GetWindowDrawList(),
                {start.x + size * 0.5f, start.y + size * 0.5f}, size * 0.34f, status);
}

void inlineStatus(Status status, const char* label) {
    statusGlyphInline(status);
    ImGui::SameLine(0.0f, densityMetrics().headGap);
    ImGui::PushStyleColor(ImGuiCol_Text, toneVec(statusTone(status)));
    ImGui::TextUnformatted(label);
    ImGui::PopStyleColor();
}

void progressBar(float fraction, ImVec2 size, Tone tone, const char* overlay) {
    if (size.x <= 0.0f) size.x = ImGui::GetContentRegionAvail().x;
    if (size.y <= 0.0f) size.y = ui::metrics::U(1.5f);
    const ImVec2 start = ImGui::GetCursorScreenPos();
    ImGui::InvisibleButton("##progress", size);
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    const float round = ui::metrics::rounding(size.y * 0.5f / ui::metrics::scale());
    drawList->AddRectFilled(start, {start.x + size.x, start.y + size.y},
                            ui::toU32(ui::palette().gaugeTrack), round);

    const bool determinate = std::isfinite(fraction) && fraction >= 0.0f && fraction <= 1.0f;
    if (determinate) {
        const float width = size.x * fraction;
        if (width > 0.0f)
            drawList->AddRectFilled(start, {start.x + width, start.y + size.y},
                                    toneU32(tone), round);
    } else {
        const float span = size.x * 0.28f;
        const float travel = size.x + span;
        const float left = std::clamp(start.x + anim::phase(anim::kMarch) * travel - span,
                                      start.x, start.x + size.x);
        const float right = std::clamp(left + span, start.x, start.x + size.x);
        drawList->AddRectFilled({left, start.y}, {right, start.y + size.y},
                                toneU32(tone), round);
    }

    if (overlay != nullptr) {
        const ImVec2 textSize = ImGui::CalcTextSize(overlay);
        drawList->AddText({start.x + (size.x - textSize.x) * 0.5f,
                           start.y + (size.y - textSize.y) * 0.5f},
                          ui::toU32(ui::palette().text), overlay);
    }
}

void spinner(const char* label) {
    const float size = ImGui::GetTextLineHeight();
    const ImVec2 start = ImGui::GetCursorScreenPos();
    ImGui::Dummy({size, size});
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    const ImVec2 center{start.x + size * 0.5f, start.y + size * 0.5f};
    const float radius = size * 0.34f;
    constexpr float kPi = 3.14159265359f;
    const float angle = anim::phase(anim::kMarch) * 2.0f * kPi;
    const ui::Palette& p = ui::palette();
    const std::array<ImVec4, 3> colors{p.accent, p.accentDim, p.accentSoft};
    for (int index = 0; index < 3; ++index) {
        const float startAngle = angle - index * 0.36f * kPi;
        drawList->PathArcTo(center, radius, startAngle, startAngle + 0.42f * kPi, 10);
        drawList->PathStroke(ui::toU32(colors[static_cast<std::size_t>(index)]), 0,
                             ui::metrics::stroke(1.5f));
    }
    if (label != nullptr) {
        ImGui::SameLine(0.0f, densityMetrics().headGap);
        ImGui::TextUnformatted(label);
    }
}

bool emptyState(const char* title, const char* body, const char* actionLabel) {
    const DensityMetrics rhythm = densityMetrics();
    ImGui::Dummy({0.0f, rhythm.sectionGap});
    // These panels are narrow and their copy is a sentence, so unwrapped text is
    // clipped mid-word at the panel edge ("Choose Open Folder or a r").
    ImGui::PushTextWrapPos(0.0f);
    if (ui::fonts().medium != nullptr) ImGui::PushFont(ui::fonts().medium);
    ImGui::TextUnformatted(title);
    if (ui::fonts().medium != nullptr) ImGui::PopFont();
    ImGui::Dummy({0.0f, rhythm.headGap});
    dimText(body);
    ImGui::PopTextWrapPos();
    if (actionLabel == nullptr) return false;
    ImGui::Dummy({0.0f, rhythm.rowGap});
    return secondaryButton(actionLabel);
}

bool blockedState(const char* reason, const char* hint, const char* actionLabel) {
    const DensityMetrics rhythm = densityMetrics();
    ImGui::PushTextWrapPos(0.0f);
    inlineStatus(Status::Failed, reason);
    ImGui::Dummy({0.0f, rhythm.headGap});
    dimText(hint);
    ImGui::PopTextWrapPos();
    if (actionLabel == nullptr) return false;
    ImGui::Dummy({0.0f, rhythm.rowGap});
    return primaryButton(actionLabel);
}

void dimText(const char* text) {
    ImGui::PushStyleColor(ImGuiCol_Text, ui::palette().textDim);
    ImGui::TextUnformatted(text != nullptr ? text : "");
    ImGui::PopStyleColor();
}

std::string elide(std::string_view text, float maxWidth) {
    if (maxWidth <= 0.0f) return {};
    if (ImGui::CalcTextSize(text.data(), text.data() + text.size()).x <= maxWidth)
        return std::string(text);

    constexpr std::string_view suffix = "…";
    if (ImGui::CalcTextSize(suffix.data(), suffix.data() + suffix.size()).x > maxWidth)
        return {};

    std::size_t accepted = 0;
    std::string candidate;
    candidate.reserve(text.size() + suffix.size());
    for (std::size_t cursor = 0; cursor < text.size();) {
        const unsigned char lead = static_cast<unsigned char>(text[cursor]);
        const std::size_t count = (lead & 0x80u) == 0u   ? 1u
                                  : (lead & 0xE0u) == 0xC0u ? 2u
                                  : (lead & 0xF0u) == 0xE0u ? 3u
                                                           : 4u;
        const std::size_t next = std::min(text.size(), cursor + count);
        candidate.assign(text.substr(0, next));
        candidate.append(suffix);
        if (ImGui::CalcTextSize(candidate.c_str()).x > maxWidth) break;
        accepted = next;
        cursor = next;
    }
    std::string result(text.substr(0, accepted));
    result.append(suffix);
    return result;
}

void keyValueRow(const char* key, const char* value, Tone tone, bool copyable) {
    const DensityMetrics rhythm = densityMetrics();
    ImGui::TextUnformatted(key);
    const float keyWidth = ImGui::CalcTextSize(key).x;
    const float copyWidth = copyable ? ImGui::CalcTextSize("Copy").x + rhythm.padX * 2.0f : 0.0f;
    const float valueStart = std::max(keyWidth + rhythm.gutter,
                                     ImGui::GetContentRegionAvail().x * 0.38f);
    ImGui::SameLine(valueStart);
    const float available = std::max(ui::metrics::stroke(),
                                     ImGui::GetContentRegionAvail().x - copyWidth);
    const std::string visible = elide(value, available);
    ImGui::PushStyleColor(ImGuiCol_Text, toneVec(tone));
    ImGui::TextUnformatted(visible.c_str());
    ImGui::PopStyleColor();
    if (visible != value && ImGui::IsItemHovered()) ImGui::SetTooltip("%s", value);

    if (copyable) {
        ImGui::SameLine();
        ImGui::PushID(key);
        if (ImGui::SmallButton("Copy")) ImGui::SetClipboardText(value);
        ImGui::PopID();
    }
}

void rule() {
    const float gap = densityMetrics().rowGap;
    ImGui::Dummy({0.0f, gap});
    const ImVec2 start = ImGui::GetCursorScreenPos();
    ImGui::GetWindowDrawList()->AddLine(
        start, {start.x + ImGui::GetContentRegionAvail().x, start.y},
        ui::toU32(ui::palette().rule), ui::metrics::stroke());
    ImGui::Dummy({0.0f, gap + ui::metrics::stroke()});
}

void gapRow() { ImGui::Dummy({0.0f, densityMetrics().rowGap}); }
void gapSection() { ImGui::Dummy({0.0f, densityMetrics().sectionGap}); }

}  // namespace chud::kit
