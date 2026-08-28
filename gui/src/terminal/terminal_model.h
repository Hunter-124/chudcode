#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <vterm.h>

namespace chud::terminal {

struct TerminalColor {
    enum class Kind { DefaultForeground, DefaultBackground, Indexed, Rgb };
    Kind kind = Kind::DefaultForeground;
    std::uint8_t index = 0;
    std::uint8_t red = 0;
    std::uint8_t green = 0;
    std::uint8_t blue = 0;
};

struct TerminalAttributes {
    bool bold = false;
    std::uint8_t underline = 0;
    bool italic = false;
    bool blink = false;
    bool reverse = false;
    bool conceal = false;
    bool strike = false;
};

struct TerminalCell {
    std::array<std::uint32_t, VTERM_MAX_CHARS_PER_CELL> chars{};
    std::uint8_t width = 1;  // 0 marks the trailing cell of a wide glyph.
    TerminalAttributes attrs;
    TerminalColor foreground;
    TerminalColor background{TerminalColor::Kind::DefaultBackground};
};

using TerminalRow = std::vector<TerminalCell>;

struct DamageRegion {
    int startRow = 0;
    int endRow = 0;
    int startCol = 0;
    int endCol = 0;
};

struct TerminalModes {
    enum class Mouse { None, Click, Drag, Move };
    enum class CursorShape { Block, Underline, Bar };

    bool alternateScreen = false;
    bool cursorVisible = true;
    bool cursorBlink = true;
    bool screenReverse = false;
    bool focusReporting = false;
    bool sgrMouse = false;
    Mouse mouse = Mouse::None;
    CursorShape cursorShape = CursorShape::Block;
};

struct SelectionPoint {
    std::size_t line = 0;  // Absolute line: scrollback first, then the live grid.
    int column = 0;
};

class TerminalModel {
public:
    using OutputCallback = std::function<void(std::span<const std::uint8_t>)>;
    using Osc52SetCallback = std::function<void(VTermSelectionMask, std::string_view)>;
    using Osc52QueryCallback = std::function<std::string(VTermSelectionMask)>;

    TerminalModel(std::string id, std::string workspaceId, int columns, int rows,
                  std::size_t scrollbackCapacity = 10'000);
    ~TerminalModel();

    TerminalModel(const TerminalModel&) = delete;
    TerminalModel& operator=(const TerminalModel&) = delete;
    TerminalModel(TerminalModel&&) = delete;
    TerminalModel& operator=(TerminalModel&&) = delete;

    [[nodiscard]] const std::string& id() const noexcept { return id_; }
    [[nodiscard]] const std::string& workspaceId() const noexcept { return workspaceId_; }
    [[nodiscard]] int columns() const noexcept { return columns_; }
    [[nodiscard]] int rows() const noexcept { return rows_; }
    [[nodiscard]] std::size_t scrollbackSize() const noexcept { return scrollback_.size(); }
    [[nodiscard]] std::size_t lineCount() const noexcept { return scrollback_.size() + static_cast<std::size_t>(rows_); }
    [[nodiscard]] const TerminalModes& modes() const noexcept { return modes_; }
    [[nodiscard]] VTermPos cursor() const noexcept { return cursor_; }
    [[nodiscard]] bool exited() const noexcept { return exited_; }
    [[nodiscard]] std::optional<int> exitCode() const noexcept { return exitCode_; }
    [[nodiscard]] const std::string& exitSignal() const noexcept { return exitSignal_; }

    // PTY output is passed byte-for-byte to libvterm. No text decoding occurs here.
    void input(std::span<const std::uint8_t> bytes);
    void input(std::string_view bytes);
    void resize(int columns, int rows);
    void markExited(std::optional<int> exitCode, std::string signal = {});

    [[nodiscard]] TerminalCell cell(int row, int column) const;
    [[nodiscard]] TerminalRow screenRow(int row) const;
    [[nodiscard]] const TerminalRow* scrollbackRow(std::size_t index) const;
    [[nodiscard]] TerminalRow rowAt(std::size_t absoluteLine) const;
    [[nodiscard]] std::string textBetween(SelectionPoint first, SelectionPoint last) const;
    [[nodiscard]] std::array<std::uint8_t, 3> resolveColor(const TerminalColor& color) const;

    [[nodiscard]] std::optional<DamageRegion> consumeDamage();

    void setOutputCallback(OutputCallback callback) { outputCallback_ = std::move(callback); }
    void setOsc52Callbacks(Osc52SetCallback set, Osc52QueryCallback query = {});

    void key(VTermKey key, VTermModifier modifiers = VTERM_MOD_NONE);
    void character(std::uint32_t codepoint, VTermModifier modifiers = VTERM_MOD_NONE);
    void paste(std::string_view bytes);
    void focus(bool focused);
    [[nodiscard]] bool mouseMove(int row, int column, VTermModifier modifiers = VTERM_MOD_NONE);
    [[nodiscard]] bool mouseButton(int button, bool pressed, VTermModifier modifiers = VTERM_MOD_NONE);

private:
    static int onDamage(VTermRect rect, void* user);
    static int onMoveRect(VTermRect dest, VTermRect src, void* user);
    static int onMoveCursor(VTermPos pos, VTermPos oldPos, int visible, void* user);
    static int onTermProperty(VTermProp property, VTermValue* value, void* user);
    static int onBell(void* user);
    static int onScreenResize(int rows, int columns, void* user);
    static int onScrollbackPush(int columns, const VTermScreenCell* cells, void* user);
    static int onScrollbackPop(int columns, VTermScreenCell* cells, void* user);
    static int onScrollbackClear(void* user);
    static void onOutput(const char* bytes, std::size_t length, void* user);
    static int onSelectionSet(VTermSelectionMask mask, VTermStringFragment fragment, void* user);
    static int onSelectionQuery(VTermSelectionMask mask, void* user);

    [[nodiscard]] static TerminalCell copyCell(const VTermScreenCell& cell);
    [[nodiscard]] static VTermScreenCell copyCell(const TerminalCell& cell);
    [[nodiscard]] static TerminalColor copyColor(const VTermColor& color, bool foreground);
    [[nodiscard]] static VTermColor copyColor(const TerminalColor& color);
    void mergeDamage(VTermRect rect);
    void scanModes(std::span<const std::uint8_t> bytes);
    void sendBytes(std::string_view bytes);

    std::string id_;
    std::string workspaceId_;
    int columns_;
    int rows_;
    std::size_t scrollbackCapacity_;
    VTerm* term_ = nullptr;
    VTermState* state_ = nullptr;
    VTermScreen* screen_ = nullptr;
    std::deque<TerminalRow> scrollback_;
    std::optional<DamageRegion> damage_;
    VTermPos cursor_{0, 0};
    TerminalModes modes_;
    bool exited_ = false;
    std::optional<int> exitCode_;
    std::string exitSignal_;
    OutputCallback outputCallback_;
    Osc52SetCallback osc52SetCallback_;
    Osc52QueryCallback osc52QueryCallback_;
    std::string osc52Incoming_;
    std::vector<char> osc52Scratch_;
    std::string modeScanTail_;
};

struct TerminalProtocolCallbacks {
    std::function<void(std::string_view terminalId, std::span<const std::uint8_t> bytes)> write;
    std::function<void(std::string_view terminalId, int columns, int rows)> resize;
    std::function<void(std::string_view terminalId)> close;
};

struct PendingTerminalResult {
    std::size_t applied = 0;
    std::size_t rejected = 0;
};

// Network callbacks only enqueue immutable wire payloads. processPending(),
// model mutation, and all libvterm/ImGui work stay on the main thread.
class TerminalModels {
public:
    explicit TerminalModels(TerminalProtocolCallbacks callbacks = {});

    TerminalModel& create(std::string terminalId, std::string workspaceId, int columns, int rows,
                          std::size_t scrollbackCapacity = 10'000);
    [[nodiscard]] TerminalModel* find(std::string_view terminalId);
    [[nodiscard]] const TerminalModel* find(std::string_view terminalId) const;
    [[nodiscard]] std::size_t size() const noexcept { return models_.size(); }

    void enqueueDataBase64(std::string terminalId, std::string dataBase64);
    void enqueueExit(std::string terminalId, std::optional<int> exitCode, std::string signal = {});
    [[nodiscard]] PendingTerminalResult processPending();

    [[nodiscard]] bool resize(std::string_view terminalId, int columns, int rows);
    [[nodiscard]] bool close(std::string_view terminalId);
    void clear();

private:
    struct PendingEvent {
        enum class Kind { Data, Exit } kind;
        std::string terminalId;
        std::string payload;
        std::optional<int> exitCode;
    };

    TerminalProtocolCallbacks callbacks_;
    std::unordered_map<std::string, std::unique_ptr<TerminalModel>> models_;
    std::mutex pendingMutex_;
    std::deque<PendingEvent> pending_;
};

}  // namespace chud::terminal
