#pragma once

#include "terminal/terminal_model.h"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include <imgui.h>

namespace chud::terminal {

class TerminalView {
public:
    // Draws one terminal and routes resize requests through TerminalModels so
    // the local libvterm grid and remote PTY remain byte/size synchronized.
    [[nodiscard]] bool draw(TerminalModels& models, std::string_view terminalId,
                            ImVec2 size = ImVec2(0.0f, 0.0f));

    void requestFocus() noexcept { requestFocus_ = true; }
    void clearSelection() noexcept;
    [[nodiscard]] std::size_t scrollOffset() const noexcept { return scrollOffset_; }

private:
    struct GridMetrics {
        ImFont* font = nullptr;
        float fontSize = 1.0f;
        float cellWidth = 1.0f;
        float cellHeight = 1.0f;
    };

    [[nodiscard]] static GridMetrics gridMetrics();
    [[nodiscard]] static std::string glyphText(const TerminalCell& cell);
    [[nodiscard]] static ImU32 foregroundColor(const TerminalModel& model, const TerminalCell& cell);
    [[nodiscard]] static ImU32 backgroundColor(const TerminalModel& model, const TerminalCell& cell);
    [[nodiscard]] bool selected(std::size_t line, int column) const;
    void routeKeyboard(TerminalModel& model);
    void routeMouse(TerminalModel& model, const ImVec2& origin, const GridMetrics& metrics,
                    std::size_t firstLine, int visibleRows);
    void drawGrid(TerminalModel& model, const ImVec2& origin, const ImVec2& size,
                  const GridMetrics& metrics, std::size_t firstLine, int visibleRows, bool focused);

    std::string terminalId_;
    std::size_t scrollOffset_ = 0;
    std::size_t previousScrollbackSize_ = 0;
    std::optional<SelectionPoint> selectionAnchor_;
    std::optional<SelectionPoint> selectionActive_;
    bool requestFocus_ = false;
    bool wasFocused_ = false;
};

}  // namespace chud::terminal
