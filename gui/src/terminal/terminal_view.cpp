#include "terminal/terminal_view.h"

#include "theme/theme.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>

namespace chud::terminal {
namespace {

ImU32 rgbColor(const std::array<std::uint8_t, 3>& rgb) {
    return IM_COL32(rgb[0], rgb[1], rgb[2], 255);
}

ImU32 terminalColor(const TerminalModel& model, const TerminalColor& color, bool foreground, bool bold) {
    const ui::Palette& palette = ui::palette();
    if (color.kind == TerminalColor::Kind::DefaultForeground) {
        return ui::toU32(palette.terminalForeground);
    }
    if (color.kind == TerminalColor::Kind::DefaultBackground) {
        return ui::toU32(palette.terminalBackground);
    }
    if (color.kind == TerminalColor::Kind::Indexed && color.index < palette.terminalAnsi.size()) {
        std::size_t index = color.index;
        if (foreground && bold && index < 8) {
            index += 8;
        }
        return ui::toU32(palette.terminalAnsi[index]);
    }
    return rgbColor(model.resolveColor(color));
}

VTermModifier keyModifiers(bool includeControl = true) {
    const ImGuiIO& io = ImGui::GetIO();
    int result = VTERM_MOD_NONE;
    if (io.KeyShift) {
        result |= VTERM_MOD_SHIFT;
    }
    if (io.KeyAlt) {
        result |= VTERM_MOD_ALT;
    }
    if (includeControl && io.KeyCtrl) {
        result |= VTERM_MOD_CTRL;
    }
    return static_cast<VTermModifier>(result);
}

std::pair<SelectionPoint, SelectionPoint> orderedSelection(SelectionPoint first, SelectionPoint second) {
    if (first.line > second.line || (first.line == second.line && first.column > second.column)) {
        std::swap(first, second);
    }
    return {first, second};
}

}  // namespace

bool TerminalView::draw(TerminalModels& models, std::string_view terminalId, ImVec2 size) {
    TerminalModel* model = models.find(terminalId);
    if (model == nullptr) {
        return false;
    }
    if (terminalId_ != terminalId) {
        terminalId_ = terminalId;
        clearSelection();
        scrollOffset_ = 0;
        previousScrollbackSize_ = model->scrollbackSize();
        wasFocused_ = false;
    }

    const ui::Palette& palette = ui::palette();
    ImGui::PushStyleColor(ImGuiCol_ChildBg, palette.terminalBackground);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0f, 0.0f));
    const std::string childId = "##terminal-" + terminalId_;
    const bool visible = ImGui::BeginChild(childId.c_str(), size, ImGuiChildFlags_None,
                                           ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
    ImGui::PopStyleVar();
    ImGui::PopStyleColor();

    if (visible) {
        const GridMetrics metrics = gridMetrics();
        ImGui::PushFont(metrics.font);
        const ImVec2 origin = ImGui::GetCursorScreenPos();
        const ImVec2 available = ImGui::GetContentRegionAvail();
        const int targetColumns = std::max(1, static_cast<int>(std::floor(available.x / metrics.cellWidth)));
        const int targetRows = std::max(1, static_cast<int>(std::floor(available.y / metrics.cellHeight)));
        if (targetColumns != model->columns() || targetRows != model->rows()) {
            models.resize(terminalId, targetColumns, targetRows);
        }

        if (scrollOffset_ != 0 && model->scrollbackSize() > previousScrollbackSize_) {
            scrollOffset_ += model->scrollbackSize() - previousScrollbackSize_;
        }
        previousScrollbackSize_ = model->scrollbackSize();
        scrollOffset_ = std::min(scrollOffset_, model->scrollbackSize());

        const int visibleRows = std::min(targetRows, model->rows());
        const std::size_t endLine = model->lineCount() - scrollOffset_;
        const std::size_t firstLine = endLine > static_cast<std::size_t>(visibleRows)
                                          ? endLine - static_cast<std::size_t>(visibleRows)
                                          : 0;

        ImGui::InvisibleButton("##terminal-grid", available,
                               ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight |
                                   ImGuiButtonFlags_MouseButtonMiddle);
        if (requestFocus_) {
            ImGui::SetWindowFocus();
            requestFocus_ = false;
        }
        if (ImGui::IsItemClicked()) {
            ImGui::SetWindowFocus();
        }
        const bool focused = ImGui::IsWindowFocused(ImGuiFocusedFlags_ChildWindows);
        if (focused != wasFocused_) {
            model->focus(focused);
            wasFocused_ = focused;
        }

        routeMouse(*model, origin, metrics, firstLine, visibleRows);
        if (focused) {
            routeKeyboard(*model);
        }
        drawGrid(*model, origin, available, metrics, firstLine, visibleRows, focused);
        ImGui::PopFont();
    }
    ImGui::EndChild();
    return true;
}

void TerminalView::clearSelection() noexcept {
    selectionAnchor_.reset();
    selectionActive_.reset();
}

TerminalView::GridMetrics TerminalView::gridMetrics() {
    ImFont* font = ui::fonts().mono != nullptr ? ui::fonts().mono : ImGui::GetFont();
    const ImGuiStyle& style = ImGui::GetStyle();
    const float height = std::max(
        font == ImGui::GetFont() ? ImGui::GetFontSize()
                                 : font->LegacySize * style.FontScaleMain * style.FontScaleDpi,
        1.0f);
    const float width = std::max(font->CalcTextSizeA(height, std::numeric_limits<float>::max(), 0.0f, "M").x, 1.0f);
    return GridMetrics{font, height, std::ceil(width), std::ceil(height + ui::metrics::px(2.0f))};
}

std::string TerminalView::glyphText(const TerminalCell& cell) {
    std::string result;
    for (const std::uint32_t codepoint : cell.chars) {
        if (codepoint == 0) {
            break;
        }
        if (codepoint <= 0x7fU) {
            result.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7ffU) {
            result.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
            result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else if (codepoint <= 0xffffU && !(codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
            result.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
            result.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else if (codepoint <= 0x10ffffU) {
            result.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
            result.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
            result.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        }
    }
    return result;
}

ImU32 TerminalView::foregroundColor(const TerminalModel& model, const TerminalCell& cell) {
    const bool reverse = cell.attrs.reverse != model.modes().screenReverse;
    const TerminalColor& color = reverse ? cell.background : cell.foreground;
    if (cell.attrs.conceal) {
        return backgroundColor(model, cell);
    }
    return terminalColor(model, color, true, cell.attrs.bold);
}

ImU32 TerminalView::backgroundColor(const TerminalModel& model, const TerminalCell& cell) {
    const bool reverse = cell.attrs.reverse != model.modes().screenReverse;
    const TerminalColor& color = reverse ? cell.foreground : cell.background;
    return terminalColor(model, color, false, false);
}

bool TerminalView::selected(std::size_t line, int column) const {
    if (!selectionAnchor_ || !selectionActive_) {
        return false;
    }
    const auto [first, last] = orderedSelection(*selectionAnchor_, *selectionActive_);
    if (line < first.line || line > last.line) {
        return false;
    }
    if (first.line == last.line) {
        return line == first.line && column >= first.column && column < last.column;
    }
    if (line == first.line) {
        return column >= first.column;
    }
    if (line == last.line) {
        return column < last.column;
    }
    return true;
}

void TerminalView::routeKeyboard(TerminalModel& model) {
    ImGuiIO& io = ImGui::GetIO();

    // App-reserved focus routing wins. Do not claim Ctrl+Tab; the IDE shell
    // sees the same key event after this panel returns.
    if (io.KeyCtrl && ImGui::IsKeyPressed(ImGuiKey_Tab)) {
        return;
    }
    if (io.KeyCtrl && io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_C)) {
        if (selectionAnchor_ && selectionActive_) {
            const auto [first, last] = orderedSelection(*selectionAnchor_, *selectionActive_);
            const std::string text = model.textBetween(first, last);
            ImGui::SetClipboardText(text.c_str());
        }
        return;
    }
    if (io.KeyCtrl && io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_V)) {
        if (const char* clipboard = ImGui::GetClipboardText(); clipboard != nullptr) {
            model.paste(clipboard);
        }
        return;
    }
    if (io.KeyCtrl && !io.KeyShift && !io.KeyAlt && !io.KeySuper && ImGui::IsKeyPressed(ImGuiKey_C)) {
        model.character('c', VTERM_MOD_CTRL);
        return;
    }

    struct KeyBinding {
        ImGuiKey imgui;
        VTermKey vterm;
    };
    static constexpr KeyBinding bindings[] = {
        {ImGuiKey_Enter, VTERM_KEY_ENTER},       {ImGuiKey_KeypadEnter, VTERM_KEY_KP_ENTER},
        {ImGuiKey_Tab, VTERM_KEY_TAB},           {ImGuiKey_Backspace, VTERM_KEY_BACKSPACE},
        {ImGuiKey_Escape, VTERM_KEY_ESCAPE},     {ImGuiKey_UpArrow, VTERM_KEY_UP},
        {ImGuiKey_DownArrow, VTERM_KEY_DOWN},    {ImGuiKey_LeftArrow, VTERM_KEY_LEFT},
        {ImGuiKey_RightArrow, VTERM_KEY_RIGHT},  {ImGuiKey_Insert, VTERM_KEY_INS},
        {ImGuiKey_Delete, VTERM_KEY_DEL},         {ImGuiKey_Home, VTERM_KEY_HOME},
        {ImGuiKey_End, VTERM_KEY_END},            {ImGuiKey_PageUp, VTERM_KEY_PAGEUP},
        {ImGuiKey_PageDown, VTERM_KEY_PAGEDOWN},
    };
    for (const KeyBinding& binding : bindings) {
        if (ImGui::IsKeyPressed(binding.imgui, true)) {
            model.key(binding.vterm, keyModifiers());
        }
    }
    for (int index = 0; index < 12; ++index) {
        const ImGuiKey key = static_cast<ImGuiKey>(ImGuiKey_F1 + index);
        if (ImGui::IsKeyPressed(key, true)) {
            model.key(static_cast<VTermKey>(VTERM_KEY_FUNCTION_0 + index + 1), keyModifiers());
        }
    }

    if (!io.KeyCtrl && !io.KeySuper) {
        const VTermModifier modifiers = io.KeyAlt ? VTERM_MOD_ALT : VTERM_MOD_NONE;
        for (const ImWchar codepoint : io.InputQueueCharacters) {
            if (codepoint != 0) {
                model.character(static_cast<std::uint32_t>(codepoint), modifiers);
            }
        }
    }
}

void TerminalView::routeMouse(TerminalModel& model, const ImVec2& origin, const GridMetrics& metrics,
                              std::size_t firstLine, int visibleRows) {
    if (!ImGui::IsItemHovered()) {
        return;
    }
    ImGuiIO& io = ImGui::GetIO();
    const int column = std::clamp(static_cast<int>((io.MousePos.x - origin.x) / metrics.cellWidth), 0, model.columns() - 1);
    const int screenRow = std::clamp(static_cast<int>((io.MousePos.y - origin.y) / metrics.cellHeight), 0, visibleRows - 1);
    const std::size_t absoluteLine = firstLine + static_cast<std::size_t>(screenRow);
    const bool remoteMouse = model.modes().mouse != TerminalModes::Mouse::None && model.modes().sgrMouse && !io.KeyShift && scrollOffset_ == 0;

    if (io.MouseWheel != 0.0f) {
        if (remoteMouse) {
            model.mouseMove(screenRow, column, keyModifiers());
            model.mouseButton(io.MouseWheel > 0.0f ? 4 : 5, true, keyModifiers());
        } else {
            const std::size_t amount = static_cast<std::size_t>(std::max(1.0f, std::abs(io.MouseWheel) * 3.0f));
            if (io.MouseWheel > 0.0f) {
                scrollOffset_ = std::min(model.scrollbackSize(), scrollOffset_ + amount);
            } else {
                scrollOffset_ = amount > scrollOffset_ ? 0 : scrollOffset_ - amount;
            }
        }
    }

    if (remoteMouse) {
        model.mouseMove(screenRow, column, keyModifiers());
        static constexpr int buttonMap[] = {1, 3, 2};
        for (int button = 0; button < 3; ++button) {
            if (ImGui::IsMouseClicked(button)) {
                model.mouseButton(buttonMap[button], true, keyModifiers());
            }
            if (ImGui::IsMouseReleased(button)) {
                model.mouseButton(buttonMap[button], false, keyModifiers());
            }
        }
        return;
    }

    if (ImGui::IsMouseClicked(ImGuiMouseButton_Left)) {
        selectionAnchor_ = SelectionPoint{absoluteLine, column};
        selectionActive_ = SelectionPoint{absoluteLine, column + 1};
    } else if (selectionAnchor_ && ImGui::IsMouseDown(ImGuiMouseButton_Left)) {
        const SelectionPoint hovered{absoluteLine, column};
        const bool beforeAnchor = hovered.line < selectionAnchor_->line ||
                                  (hovered.line == selectionAnchor_->line && hovered.column < selectionAnchor_->column);
        selectionActive_ = SelectionPoint{absoluteLine, column + (beforeAnchor ? 0 : 1)};
    }
}

void TerminalView::drawGrid(TerminalModel& model, const ImVec2& origin, const ImVec2& size,
                            const GridMetrics& metrics, std::size_t firstLine, int visibleRows, bool focused) {
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    const ui::Palette& palette = ui::palette();
    drawList->PushClipRect(origin, ImVec2(origin.x + size.x, origin.y + size.y), true);

    for (int rowIndex = 0; rowIndex < visibleRows; ++rowIndex) {
        const std::size_t absoluteLine = firstLine + static_cast<std::size_t>(rowIndex);
        const TerminalRow row = model.rowAt(absoluteLine);
        for (int column = 0; column < model.columns(); ++column) {
            const TerminalCell cell = column < static_cast<int>(row.size()) ? row[static_cast<std::size_t>(column)] : TerminalCell{};
            const float x = origin.x + static_cast<float>(column) * metrics.cellWidth;
            const float y = origin.y + static_cast<float>(rowIndex) * metrics.cellHeight;
            const float width = metrics.cellWidth * static_cast<float>(std::max<std::uint8_t>(cell.width, 1));
            const ImVec2 minimum(x, y);
            const ImVec2 maximum(x + width, y + metrics.cellHeight);
            drawList->AddRectFilled(minimum, maximum, backgroundColor(model, cell));
            if (selected(absoluteLine, column)) {
                drawList->AddRectFilled(minimum, maximum, ui::toU32(palette.terminalSelection));
            }
            if (cell.width == 0 || cell.chars[0] == 0 ||
                (cell.attrs.blink && std::fmod(ImGui::GetTime(), 1.0) >= 0.5)) {
                continue;
            }
            const std::string glyph = glyphText(cell);
            const ImU32 foreground = foregroundColor(model, cell);
            drawList->AddText(metrics.font, metrics.fontSize, minimum, foreground, glyph.c_str());
            const float stroke = ui::metrics::stroke();
            if (cell.attrs.underline != VTERM_UNDERLINE_OFF) {
                const float underlineY = maximum.y - stroke;
                if (cell.attrs.underline == VTERM_UNDERLINE_CURLY) {
                    const float half = metrics.cellWidth * 0.25f;
                    for (float waveX = minimum.x; waveX < maximum.x; waveX += half * 2.0f) {
                        drawList->AddLine(ImVec2(waveX, underlineY), ImVec2(std::min(waveX + half, maximum.x), underlineY - stroke), foreground, stroke);
                        drawList->AddLine(ImVec2(std::min(waveX + half, maximum.x), underlineY - stroke),
                                          ImVec2(std::min(waveX + half * 2.0f, maximum.x), underlineY), foreground, stroke);
                    }
                } else {
                    drawList->AddLine(ImVec2(minimum.x, underlineY), ImVec2(maximum.x, underlineY), foreground, stroke);
                    if (cell.attrs.underline == VTERM_UNDERLINE_DOUBLE) {
                        drawList->AddLine(ImVec2(minimum.x, underlineY - stroke * 2.0f),
                                          ImVec2(maximum.x, underlineY - stroke * 2.0f), foreground, stroke);
                    }
                }
            }
            if (cell.attrs.strike) {
                const float strikeY = minimum.y + metrics.cellHeight * 0.5f;
                drawList->AddLine(ImVec2(minimum.x, strikeY), ImVec2(maximum.x, strikeY), foreground, ui::metrics::stroke());
            }
        }
    }

    const std::size_t cursorLine = model.scrollbackSize() + static_cast<std::size_t>(model.cursor().row);
    const bool cursorBlinkOn = !model.modes().cursorBlink || std::fmod(ImGui::GetTime(), 1.0) < 0.5;
    if (focused && model.modes().cursorVisible && cursorBlinkOn && cursorLine >= firstLine &&
        cursorLine < firstLine + static_cast<std::size_t>(visibleRows)) {
        const float x = origin.x + static_cast<float>(model.cursor().col) * metrics.cellWidth;
        const float y = origin.y + static_cast<float>(cursorLine - firstLine) * metrics.cellHeight;
        const ImU32 cursorColor = ui::toU32(palette.accent);
        if (model.modes().cursorShape == TerminalModes::CursorShape::Underline) {
            drawList->AddRectFilled(ImVec2(x, y + metrics.cellHeight - ui::metrics::stroke(2.0f)),
                                    ImVec2(x + metrics.cellWidth, y + metrics.cellHeight), cursorColor);
        } else if (model.modes().cursorShape == TerminalModes::CursorShape::Bar) {
            drawList->AddRectFilled(ImVec2(x, y), ImVec2(x + ui::metrics::stroke(2.0f), y + metrics.cellHeight), cursorColor);
        } else {
            drawList->AddRect(ImVec2(x, y), ImVec2(x + metrics.cellWidth, y + metrics.cellHeight), cursorColor,
                              0.0f, 0, ui::metrics::stroke());
        }
    }
    drawList->PopClipRect();
}

}  // namespace chud::terminal
