#include "terminal/terminal_model.h"

#include "terminal/base64.h"

#include <algorithm>
#include <iterator>
#include <limits>
#include <new>
#include <utility>

namespace chud::terminal {
namespace {

constexpr std::size_t kOsc52ScratchBytes = 64 * 1024;

void appendUtf8(std::string& result, std::uint32_t codepoint) {
    if (codepoint <= 0x7fU) {
        result.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7ffU) {
        result.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
        result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
    } else if (codepoint >= 0xd800U && codepoint <= 0xdfffU) {
        appendUtf8(result, 0xfffdU);
    } else if (codepoint <= 0xffffU) {
        result.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
        result.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
        result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
    } else if (codepoint <= 0x10ffffU) {
        result.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
        result.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
        result.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
        result.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
    } else {
        appendUtf8(result, 0xfffdU);
    }
}

std::optional<bool> sgrMouseSetting(std::string_view parameters, bool enabled) {
    std::optional<bool> result;
    std::size_t start = 0;
    while (start <= parameters.size()) {
        const std::size_t end = parameters.find(';', start);
        const std::string_view item =
            parameters.substr(start, end == std::string_view::npos ? parameters.size() - start : end - start);
        if (item == "1006") {
            result = enabled;
        } else if (item == "1005" || item == "1015") {
            // libvterm supports these legacy wide-coordinate encodings; the
            // native view intentionally does not forward them.
            result = false;
        }
        if (end == std::string_view::npos) {
            break;
        }
        start = end + 1;
    }
    return result;
}

VTermModifier clampModifiers(VTermModifier modifiers) {
    return static_cast<VTermModifier>(static_cast<int>(modifiers) & VTERM_ALL_MODS_MASK);
}

}  // namespace

TerminalModel::TerminalModel(std::string id, std::string workspaceId, int columns, int rows,
                             std::size_t scrollbackCapacity)
    : id_(std::move(id)),
      workspaceId_(std::move(workspaceId)),
      columns_(std::max(columns, 1)),
      rows_(std::max(rows, 1)),
      scrollbackCapacity_(scrollbackCapacity),
      osc52Scratch_(kOsc52ScratchBytes) {
    term_ = vterm_new(rows_, columns_);
    if (term_ == nullptr) {
        throw std::bad_alloc();
    }
    vterm_set_utf8(term_, 1);
    state_ = vterm_obtain_state(term_);
    screen_ = vterm_obtain_screen(term_);

    static const VTermScreenCallbacks screenCallbacks = {
        .damage = &TerminalModel::onDamage,
        .moverect = &TerminalModel::onMoveRect,
        .movecursor = &TerminalModel::onMoveCursor,
        .settermprop = &TerminalModel::onTermProperty,
        .bell = &TerminalModel::onBell,
        .resize = &TerminalModel::onScreenResize,
        .sb_pushline = &TerminalModel::onScrollbackPush,
        .sb_popline = &TerminalModel::onScrollbackPop,
        .sb_clear = &TerminalModel::onScrollbackClear,
        .sb_pushline4 = nullptr,
    };
    static const VTermSelectionCallbacks selectionCallbacks = {
        .set = &TerminalModel::onSelectionSet,
        .query = &TerminalModel::onSelectionQuery,
    };

    vterm_output_set_callback(term_, &TerminalModel::onOutput, this);
    vterm_screen_set_callbacks(screen_, &screenCallbacks, this);
    vterm_screen_enable_altscreen(screen_, 1);
    vterm_screen_enable_reflow(screen_, true);
    vterm_screen_set_damage_merge(screen_, VTERM_DAMAGE_SCROLL);
    vterm_state_set_selection_callbacks(state_, &selectionCallbacks, this, osc52Scratch_.data(), osc52Scratch_.size());
    vterm_screen_reset(screen_, 1);
    vterm_screen_flush_damage(screen_);
    mergeDamage(VTermRect{0, rows_, 0, columns_});
}

TerminalModel::~TerminalModel() {
    if (term_ != nullptr) {
        vterm_free(term_);
    }
}

void TerminalModel::input(std::span<const std::uint8_t> bytes) {
    if (bytes.empty()) {
        return;
    }
    scanModes(bytes);
    vterm_input_write(term_, reinterpret_cast<const char*>(bytes.data()), bytes.size());
    vterm_screen_flush_damage(screen_);
}

void TerminalModel::input(std::string_view bytes) {
    input(std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size()));
}

void TerminalModel::resize(int columns, int rows) {
    columns = std::max(columns, 1);
    rows = std::max(rows, 1);
    if (columns == columns_ && rows == rows_) {
        return;
    }

    VTermPos stateCursor{};
    vterm_state_get_cursorpos(state_, &stateCursor);
    const VTermLineInfo* cursorLine =
        stateCursor.row >= 0 && stateCursor.row < rows_ ? vterm_state_get_lineinfo(state_, stateCursor.row) : nullptr;
    const VTermLineInfo* nextLine =
        stateCursor.row >= 0 && stateCursor.row + 1 < rows_ ? vterm_state_get_lineinfo(state_, stateCursor.row + 1) : nullptr;
    const bool cursorEndsWrappedLine =
        cursorLine != nullptr && cursorLine->continuation && (nextLine == nullptr || !nextLine->continuation);
    const bool suspendReflow = cursorEndsWrappedLine && (columns < columns_ || rows < rows_);

    // libvterm's reflow path aborts when a shrinking resize truncates a
    // wrapped logical line whose final continuation row contains the cursor.
    // Its non-reflow path clamps that cursor correctly; preserve reflow for
    // every other resize and restore it immediately afterward.
    if (suspendReflow) {
        vterm_screen_enable_reflow(screen_, false);
    }
    vterm_set_size(term_, rows, columns);
    if (suspendReflow) {
        vterm_screen_enable_reflow(screen_, true);
    }

    columns_ = columns;
    rows_ = rows;
    cursor_.row = std::clamp(cursor_.row, 0, rows_ - 1);
    cursor_.col = std::clamp(cursor_.col, 0, columns_ - 1);
    mergeDamage(VTermRect{0, rows_, 0, columns_});
    vterm_screen_flush_damage(screen_);
}

void TerminalModel::markExited(std::optional<int> exitCode, std::string signal) {
    exited_ = true;
    exitCode_ = exitCode;
    exitSignal_ = std::move(signal);
}

TerminalCell TerminalModel::cell(int row, int column) const {
    VTermScreenCell source{};
    if (row < 0 || row >= rows_ || column < 0 || column >= columns_ ||
        !vterm_screen_get_cell(screen_, VTermPos{row, column}, &source)) {
        return {};
    }
    return copyCell(source);
}

TerminalRow TerminalModel::screenRow(int row) const {
    TerminalRow result;
    if (row < 0 || row >= rows_) {
        return result;
    }
    result.reserve(static_cast<std::size_t>(columns_));
    for (int column = 0; column < columns_; ++column) {
        result.push_back(cell(row, column));
    }
    return result;
}

const TerminalRow* TerminalModel::scrollbackRow(std::size_t index) const {
    return index < scrollback_.size() ? &scrollback_[index] : nullptr;
}

TerminalRow TerminalModel::rowAt(std::size_t absoluteLine) const {
    if (absoluteLine < scrollback_.size()) {
        return scrollback_[absoluteLine];
    }
    const std::size_t screenIndex = absoluteLine - scrollback_.size();
    return screenIndex < static_cast<std::size_t>(rows_) ? screenRow(static_cast<int>(screenIndex)) : TerminalRow{};
}

std::string TerminalModel::textBetween(SelectionPoint first, SelectionPoint last) const {
    if (lineCount() == 0) {
        return {};
    }
    if (first.line > last.line || (first.line == last.line && first.column > last.column)) {
        std::swap(first, last);
    }
    const std::size_t finalLine = lineCount() - 1;
    first.line = std::min(first.line, finalLine);
    last.line = std::min(last.line, finalLine);

    std::string result;
    for (std::size_t line = first.line; line <= last.line; ++line) {
        const TerminalRow row = rowAt(line);
        const int begin = line == first.line ? std::clamp(first.column, 0, static_cast<int>(row.size())) : 0;
        const int end = line == last.line ? std::clamp(last.column, begin, static_cast<int>(row.size())) : static_cast<int>(row.size());
        const std::size_t lineStart = result.size();
        for (int column = begin; column < end; ++column) {
            const TerminalCell& current = row[static_cast<std::size_t>(column)];
            if (current.width == 0) {
                continue;
            }
            if (current.chars[0] == 0) {
                result.push_back(' ');
                continue;
            }
            for (std::uint32_t codepoint : current.chars) {
                if (codepoint == 0) {
                    break;
                }
                appendUtf8(result, codepoint);
            }
        }
        while (result.size() > lineStart && result.back() == ' ') {
            result.pop_back();
        }
        if (line != last.line) {
            result.push_back('\n');
        }
    }
    return result;
}

std::array<std::uint8_t, 3> TerminalModel::resolveColor(const TerminalColor& color) const {
    VTermColor resolved = copyColor(color);
    vterm_screen_convert_color_to_rgb(screen_, &resolved);
    return {resolved.rgb.red, resolved.rgb.green, resolved.rgb.blue};
}

std::optional<DamageRegion> TerminalModel::consumeDamage() {
    auto result = damage_;
    damage_.reset();
    return result;
}

void TerminalModel::setOsc52Callbacks(Osc52SetCallback set, Osc52QueryCallback query) {
    osc52SetCallback_ = std::move(set);
    osc52QueryCallback_ = std::move(query);
}

void TerminalModel::key(VTermKey keyValue, VTermModifier modifiers) {
    vterm_keyboard_key(term_, keyValue, clampModifiers(modifiers));
}

void TerminalModel::character(std::uint32_t codepoint, VTermModifier modifiers) {
    vterm_keyboard_unichar(term_, codepoint, clampModifiers(modifiers));
}

void TerminalModel::paste(std::string_view bytes) {
    vterm_keyboard_start_paste(term_);
    sendBytes(bytes);
    vterm_keyboard_end_paste(term_);
}

void TerminalModel::focus(bool focused) {
    if (focused) {
        vterm_state_focus_in(state_);
    } else {
        vterm_state_focus_out(state_);
    }
}

bool TerminalModel::mouseMove(int row, int column, VTermModifier modifiers) {
    if (modes_.mouse == TerminalModes::Mouse::None || !modes_.sgrMouse) {
        return false;
    }
    row = std::clamp(row, 0, rows_ - 1);
    column = std::clamp(column, 0, columns_ - 1);
    vterm_mouse_move(term_, row, column, clampModifiers(modifiers));
    return true;
}

bool TerminalModel::mouseButton(int button, bool pressed, VTermModifier modifiers) {
    if (modes_.mouse == TerminalModes::Mouse::None || !modes_.sgrMouse) {
        return false;
    }
    vterm_mouse_button(term_, button, pressed, clampModifiers(modifiers));
    return true;
}

int TerminalModel::onDamage(VTermRect rect, void* user) {
    static_cast<TerminalModel*>(user)->mergeDamage(rect);
    return 1;
}

int TerminalModel::onMoveRect(VTermRect dest, VTermRect src, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    model.mergeDamage(dest);
    model.mergeDamage(src);
    return 1;
}

int TerminalModel::onMoveCursor(VTermPos pos, VTermPos oldPos, int visible, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    model.cursor_ = pos;
    model.modes_.cursorVisible = visible != 0;
    model.mergeDamage(VTermRect{oldPos.row, oldPos.row + 1, oldPos.col, oldPos.col + 1});
    model.mergeDamage(VTermRect{pos.row, pos.row + 1, pos.col, pos.col + 1});
    return 1;
}

int TerminalModel::onTermProperty(VTermProp property, VTermValue* value, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    switch (property) {
    case VTERM_PROP_CURSORVISIBLE:
        model.modes_.cursorVisible = value->boolean != 0;
        model.mergeDamage(VTermRect{model.cursor_.row, model.cursor_.row + 1,
                                    model.cursor_.col, model.cursor_.col + 1});
        break;
    case VTERM_PROP_CURSORBLINK:
        model.modes_.cursorBlink = value->boolean != 0;
        model.mergeDamage(VTermRect{model.cursor_.row, model.cursor_.row + 1,
                                    model.cursor_.col, model.cursor_.col + 1});
        break;
    case VTERM_PROP_REVERSE:
        model.modes_.screenReverse = value->boolean != 0;
        model.mergeDamage(VTermRect{0, model.rows_, 0, model.columns_});
        break;
    case VTERM_PROP_ALTSCREEN:
        model.modes_.alternateScreen = value->boolean != 0;
        model.mergeDamage(VTermRect{0, model.rows_, 0, model.columns_});
        break;
    case VTERM_PROP_CURSORSHAPE:
        if (value->number == VTERM_PROP_CURSORSHAPE_UNDERLINE) {
            model.modes_.cursorShape = TerminalModes::CursorShape::Underline;
        } else if (value->number == VTERM_PROP_CURSORSHAPE_BAR_LEFT) {
            model.modes_.cursorShape = TerminalModes::CursorShape::Bar;
        } else {
            model.modes_.cursorShape = TerminalModes::CursorShape::Block;
        }
        model.mergeDamage(VTermRect{model.cursor_.row, model.cursor_.row + 1,
                                    model.cursor_.col, model.cursor_.col + 1});
        break;
    case VTERM_PROP_MOUSE:
        if (value->number == VTERM_PROP_MOUSE_CLICK) {
            model.modes_.mouse = TerminalModes::Mouse::Click;
        } else if (value->number == VTERM_PROP_MOUSE_DRAG) {
            model.modes_.mouse = TerminalModes::Mouse::Drag;
        } else if (value->number == VTERM_PROP_MOUSE_MOVE) {
            model.modes_.mouse = TerminalModes::Mouse::Move;
        } else {
            model.modes_.mouse = TerminalModes::Mouse::None;
        }
        break;
    case VTERM_PROP_FOCUSREPORT:
        model.modes_.focusReporting = value->boolean != 0;
        break;
    case VTERM_PROP_TITLE:
    case VTERM_PROP_ICONNAME:
    case VTERM_N_PROPS:
        break;
    }
    return 1;
}

int TerminalModel::onBell(void*) {
    return 1;
}

int TerminalModel::onScreenResize(int rows, int columns, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    model.rows_ = std::max(rows, 1);
    model.columns_ = std::max(columns, 1);
    model.mergeDamage(VTermRect{0, model.rows_, 0, model.columns_});
    return 1;
}

int TerminalModel::onScrollbackPush(int columns, const VTermScreenCell* cells, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    if (model.modes_.alternateScreen || model.scrollbackCapacity_ == 0) {
        return 1;
    }
    TerminalRow row;
    row.reserve(static_cast<std::size_t>(std::max(columns, 0)));
    for (int column = 0; column < columns; ++column) {
        row.push_back(copyCell(cells[column]));
    }
    if (model.scrollback_.size() == model.scrollbackCapacity_) {
        model.scrollback_.pop_front();
    }
    model.scrollback_.push_back(std::move(row));
    return 1;
}

int TerminalModel::onScrollbackPop(int columns, VTermScreenCell* cells, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    if (model.modes_.alternateScreen || model.scrollback_.empty()) {
        return 0;
    }
    TerminalRow row = std::move(model.scrollback_.back());
    model.scrollback_.pop_back();
    for (int column = 0; column < columns; ++column) {
        cells[column] = column < static_cast<int>(row.size())
                            ? copyCell(row[static_cast<std::size_t>(column)])
                            : copyCell(TerminalCell{});
    }
    return 1;
}

int TerminalModel::onScrollbackClear(void* user) {
    static_cast<TerminalModel*>(user)->scrollback_.clear();
    return 1;
}

void TerminalModel::onOutput(const char* bytes, std::size_t length, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    if (model.outputCallback_ && length != 0) {
        model.outputCallback_(std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(bytes), length));
    }
}

int TerminalModel::onSelectionSet(VTermSelectionMask mask, VTermStringFragment fragment, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    if (fragment.initial) {
        model.osc52Incoming_.clear();
    }
    if (fragment.str != nullptr && fragment.len != 0) {
        model.osc52Incoming_.append(fragment.str, fragment.len);
    }
    if (fragment.final && model.osc52SetCallback_) {
        model.osc52SetCallback_(mask, model.osc52Incoming_);
    }
    return 1;
}

int TerminalModel::onSelectionQuery(VTermSelectionMask mask, void* user) {
    auto& model = *static_cast<TerminalModel*>(user);
    const std::string selection = model.osc52QueryCallback_ ? model.osc52QueryCallback_(mask) : std::string{};
    constexpr std::size_t kFragmentBytes = 64 * 1024;
    if (selection.empty()) {
        const VTermStringFragment fragment{.str = selection.data(), .len = 0, .initial = true, .final = true};
        vterm_state_send_selection(model.state_, mask, fragment);
        return 1;
    }
    for (std::size_t offset = 0; offset < selection.size(); offset += kFragmentBytes) {
        const std::size_t length = std::min(kFragmentBytes, selection.size() - offset);
        const VTermStringFragment fragment{
            .str = selection.data() + offset,
            .len = length,
            .initial = offset == 0,
            .final = offset + length == selection.size(),
        };
        vterm_state_send_selection(model.state_, mask, fragment);
    }
    return 1;
}

TerminalCell TerminalModel::copyCell(const VTermScreenCell& cellValue) {
    TerminalCell result;
    if (cellValue.chars[0] == std::numeric_limits<std::uint32_t>::max()) {
        // libvterm exposes a wide glyph's trailing cell with its internal
        // UINT32_MAX sentinel and width 1. Normalize it for model consumers.
        result.width = 0;
    } else {
        std::copy(std::begin(cellValue.chars), std::end(cellValue.chars), result.chars.begin());
        result.width = static_cast<std::uint8_t>(std::max<int>(cellValue.width, 0));
    }
    result.attrs.bold = cellValue.attrs.bold != 0;
    result.attrs.underline = static_cast<std::uint8_t>(cellValue.attrs.underline);
    result.attrs.italic = cellValue.attrs.italic != 0;
    result.attrs.blink = cellValue.attrs.blink != 0;
    result.attrs.reverse = cellValue.attrs.reverse != 0;
    result.attrs.conceal = cellValue.attrs.conceal != 0;
    result.attrs.strike = cellValue.attrs.strike != 0;
    result.foreground = copyColor(cellValue.fg, true);
    result.background = copyColor(cellValue.bg, false);
    return result;
}

VTermScreenCell TerminalModel::copyCell(const TerminalCell& cellValue) {
    VTermScreenCell result{};
    if (cellValue.width == 0) {
        // Restore libvterm's external-cell representation for sb_popline.
        // Returning width 0 would make libvterm's resize loop stop advancing.
        result.chars[0] = std::numeric_limits<std::uint32_t>::max();
        result.width = 1;
    } else {
        std::copy(cellValue.chars.begin(), cellValue.chars.end(), std::begin(result.chars));
        result.width = static_cast<char>(cellValue.width);
    }
    result.attrs.bold = cellValue.attrs.bold;
    result.attrs.underline = cellValue.attrs.underline;
    result.attrs.italic = cellValue.attrs.italic;
    result.attrs.blink = cellValue.attrs.blink;
    result.attrs.reverse = cellValue.attrs.reverse;
    result.attrs.conceal = cellValue.attrs.conceal;
    result.attrs.strike = cellValue.attrs.strike;
    result.fg = copyColor(cellValue.foreground);
    result.bg = copyColor(cellValue.background);
    return result;
}

TerminalColor TerminalModel::copyColor(const VTermColor& color, bool foreground) {
    TerminalColor result;
    if (foreground && VTERM_COLOR_IS_DEFAULT_FG(&color)) {
        result.kind = TerminalColor::Kind::DefaultForeground;
    } else if (!foreground && VTERM_COLOR_IS_DEFAULT_BG(&color)) {
        result.kind = TerminalColor::Kind::DefaultBackground;
    } else if (VTERM_COLOR_IS_INDEXED(&color)) {
        result.kind = TerminalColor::Kind::Indexed;
        result.index = color.indexed.idx;
    } else {
        result.kind = TerminalColor::Kind::Rgb;
        result.red = color.rgb.red;
        result.green = color.rgb.green;
        result.blue = color.rgb.blue;
    }
    return result;
}

VTermColor TerminalModel::copyColor(const TerminalColor& color) {
    VTermColor result{};
    switch (color.kind) {
    case TerminalColor::Kind::DefaultForeground:
        vterm_color_indexed(&result, 7);
        result.type |= VTERM_COLOR_DEFAULT_FG;
        break;
    case TerminalColor::Kind::DefaultBackground:
        vterm_color_indexed(&result, 0);
        result.type |= VTERM_COLOR_DEFAULT_BG;
        break;
    case TerminalColor::Kind::Indexed:
        vterm_color_indexed(&result, color.index);
        break;
    case TerminalColor::Kind::Rgb:
        vterm_color_rgb(&result, color.red, color.green, color.blue);
        break;
    }
    return result;
}

void TerminalModel::mergeDamage(VTermRect rect) {
    rect.start_row = std::clamp(rect.start_row, 0, rows_);
    rect.end_row = std::clamp(rect.end_row, 0, rows_);
    rect.start_col = std::clamp(rect.start_col, 0, columns_);
    rect.end_col = std::clamp(rect.end_col, 0, columns_);
    if (rect.start_row >= rect.end_row || rect.start_col >= rect.end_col) {
        return;
    }
    if (!damage_) {
        damage_ = DamageRegion{rect.start_row, rect.end_row, rect.start_col, rect.end_col};
        return;
    }
    damage_->startRow = std::min(damage_->startRow, rect.start_row);
    damage_->endRow = std::max(damage_->endRow, rect.end_row);
    damage_->startCol = std::min(damage_->startCol, rect.start_col);
    damage_->endCol = std::max(damage_->endCol, rect.end_col);
}

void TerminalModel::scanModes(std::span<const std::uint8_t> bytes) {
    std::string stream = std::move(modeScanTail_);
    stream.append(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    modeScanTail_.clear();

    std::size_t index = 0;
    while (index < stream.size()) {
        if (static_cast<unsigned char>(stream[index]) == 0x1bU) {
            if (index + 1 >= stream.size()) {
                modeScanTail_ = stream.substr(index);
                break;
            }
            if (stream[index + 1] == 'c') {
                modes_.sgrMouse = false;
                index += 2;
                continue;
            }
        }

        std::size_t parameterStart = std::string::npos;
        if (static_cast<unsigned char>(stream[index]) == 0x9bU) {
            parameterStart = index + 1;
        } else if (static_cast<unsigned char>(stream[index]) == 0x1bU && stream[index + 1] == '[') {
            parameterStart = index + 2;
        }
        if (parameterStart == std::string::npos) {
            ++index;
            continue;
        }

        std::size_t final = parameterStart;
        while (final < stream.size()) {
            const unsigned char current = static_cast<unsigned char>(stream[final]);
            if (current >= 0x40U && current <= 0x7eU) {
                break;
            }
            ++final;
        }
        if (final == stream.size()) {
            modeScanTail_ = stream.substr(index);
            if (modeScanTail_.size() > 64) {
                modeScanTail_.erase(0, modeScanTail_.size() - 64);
            }
            break;
        }
        if ((stream[final] == 'h' || stream[final] == 'l') && parameterStart < final && stream[parameterStart] == '?') {
            const std::string_view parameters(stream.data() + parameterStart + 1, final - parameterStart - 1);
            if (const auto setting = sgrMouseSetting(parameters, stream[final] == 'h')) {
                modes_.sgrMouse = *setting;
            }
        }
        index = final + 1;
    }
}

void TerminalModel::sendBytes(std::string_view bytes) {
    if (outputCallback_ && !bytes.empty()) {
        outputCallback_(std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size()));
    }
}

TerminalModels::TerminalModels(TerminalProtocolCallbacks callbacks) : callbacks_(std::move(callbacks)) {}

TerminalModel& TerminalModels::create(std::string terminalId, std::string workspaceId, int columns, int rows,
                                      std::size_t scrollbackCapacity) {
    if (auto* existing = find(terminalId)) {
        return *existing;
    }
    auto model = std::make_unique<TerminalModel>(terminalId, std::move(workspaceId), columns, rows, scrollbackCapacity);
    model->setOutputCallback([this, id = terminalId](std::span<const std::uint8_t> bytes) {
        if (callbacks_.write) {
            callbacks_.write(id, bytes);
        }
    });
    TerminalModel& result = *model;
    models_.emplace(std::move(terminalId), std::move(model));
    return result;
}

TerminalModel* TerminalModels::find(std::string_view terminalId) {
    const auto it = models_.find(std::string(terminalId));
    return it == models_.end() ? nullptr : it->second.get();
}

const TerminalModel* TerminalModels::find(std::string_view terminalId) const {
    const auto it = models_.find(std::string(terminalId));
    return it == models_.end() ? nullptr : it->second.get();
}

void TerminalModels::enqueueDataBase64(std::string terminalId, std::string dataBase64) {
    std::lock_guard lock(pendingMutex_);
    pending_.push_back(PendingEvent{PendingEvent::Kind::Data, std::move(terminalId), std::move(dataBase64), std::nullopt});
}

void TerminalModels::enqueueExit(std::string terminalId, std::optional<int> exitCode, std::string signal) {
    std::lock_guard lock(pendingMutex_);
    pending_.push_back(PendingEvent{PendingEvent::Kind::Exit, std::move(terminalId), std::move(signal), exitCode});
}

PendingTerminalResult TerminalModels::processPending() {
    std::deque<PendingEvent> events;
    {
        std::lock_guard lock(pendingMutex_);
        events.swap(pending_);
    }

    PendingTerminalResult result;
    for (auto& event : events) {
        TerminalModel* model = find(event.terminalId);
        if (model == nullptr) {
            ++result.rejected;
            continue;
        }
        if (event.kind == PendingEvent::Kind::Data) {
            auto decoded = decodeBase64Strict(event.payload);
            if (!decoded) {
                ++result.rejected;
                continue;
            }
            model->input(*decoded);
        } else {
            model->markExited(event.exitCode, std::move(event.payload));
        }
        ++result.applied;
    }
    return result;
}

bool TerminalModels::resize(std::string_view terminalId, int columns, int rows) {
    TerminalModel* model = find(terminalId);
    if (model == nullptr) {
        return false;
    }
    columns = std::max(columns, 1);
    rows = std::max(rows, 1);
    model->resize(columns, rows);
    if (callbacks_.resize) {
        callbacks_.resize(terminalId, columns, rows);
    }
    return true;
}

bool TerminalModels::close(std::string_view terminalId) {
    const auto it = models_.find(std::string(terminalId));
    if (it == models_.end()) {
        return false;
    }
    if (callbacks_.close) {
        callbacks_.close(terminalId);
    }
    models_.erase(it);
    return true;
}

void TerminalModels::clear() {
    models_.clear();
    std::lock_guard lock(pendingMutex_);
    pending_.clear();
}

}  // namespace chud::terminal
