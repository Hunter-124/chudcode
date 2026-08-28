#include "terminal/base64.h"
#include "terminal/terminal_model.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace {

using chud::terminal::DamageRegion;
using chud::terminal::SelectionPoint;
using chud::terminal::TerminalCell;
using chud::terminal::TerminalColor;
using chud::terminal::TerminalModel;
using chud::terminal::TerminalModels;
using chud::terminal::TerminalProtocolCallbacks;

int failures = 0;

void expect(bool condition, std::string_view message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

std::string bytes(std::span<const std::uint8_t> value) {
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}

std::string rowText(const TerminalModel& model, int row) {
    std::string result;
    for (int column = 0; column < model.columns(); ++column) {
        const TerminalCell cell = model.cell(row, column);
        if (cell.width == 0) {
            continue;
        }
        if (cell.chars[0] == 0) {
            result.push_back(' ');
        } else if (cell.chars[0] < 0x80) {
            result.push_back(static_cast<char>(cell.chars[0]));
        }
    }
    while (!result.empty() && result.back() == ' ') {
        result.pop_back();
    }
    return result;
}

void testBase64() {
    using chud::terminal::decodeBase64Strict;
    const auto empty = decodeBase64Strict("");
    expect(empty && empty->empty(), "empty base64 is exact empty bytes");

    const auto one = decodeBase64Strict("Zg==");
    expect(one && bytes(*one) == "f", "one-byte base64 decodes exactly");
    const auto two = decodeBase64Strict("Zm8=");
    expect(two && bytes(*two) == "fo", "two-byte base64 decodes exactly");
    const auto three = decodeBase64Strict("Zm9v");
    expect(three && bytes(*three) == "foo", "unpadded quartet decodes exactly");
    const auto binary = decodeBase64Strict("AP+A");
    expect(binary && *binary == std::vector<std::uint8_t>({0x00, 0xff, 0x80}), "binary bytes are not text-decoded");

    constexpr std::array invalid = {
        "Zg", "Zg=", "Z===", "====", "Zm=8", "Zm9v=", "Zm9v\n", "Zm-v", "Zm_v",
        "Zh==",  // discarded low bits must be zero
        "Zm9=",  // discarded low bits must be zero
    };
    for (const std::string_view value : invalid) {
        expect(!decodeBase64Strict(value), std::string("strict base64 rejects: ") + std::string(value));
    }
}

void testGridAndAttributes() {
    TerminalModel model("grid", "workspace-a", 12, 4);
    model.consumeDamage();
    model.input("A\x1b[1;3;4;9;38;2;1;2;3;48;2;4;5;6mB\x1b[0mC");

    expect(model.cell(0, 0).chars[0] == 'A', "basic grid cell");
    const TerminalCell styled = model.cell(0, 1);
    expect(styled.chars[0] == 'B', "SGR glyph lands in expected cell");
    expect(styled.attrs.bold && styled.attrs.italic && styled.attrs.underline == VTERM_UNDERLINE_SINGLE && styled.attrs.strike,
           "SGR attributes survive screen cell copy");
    expect(styled.foreground.kind == TerminalColor::Kind::Rgb && styled.foreground.red == 1 && styled.foreground.green == 2 &&
               styled.foreground.blue == 3,
           "truecolor foreground is exact");
    expect(styled.background.kind == TerminalColor::Kind::Rgb && styled.background.red == 4 && styled.background.green == 5 &&
               styled.background.blue == 6,
           "truecolor background is exact");
    expect(!model.cell(0, 2).attrs.bold, "SGR reset restores attributes");
    model.input("\x1b[31;104mD\x1b[38;5;200mE");
    const TerminalCell indexed = model.cell(0, 3);
    expect(indexed.foreground.kind == TerminalColor::Kind::Indexed && indexed.foreground.index == 1 &&
               indexed.background.kind == TerminalColor::Kind::Indexed && indexed.background.index == 12,
           "16-color SGR indices are preserved for semantic theme lookup");
    expect(model.cell(0, 4).foreground.kind == TerminalColor::Kind::Indexed &&
               model.cell(0, 4).foreground.index == 200,
           "256-color SGR index is preserved");

    const auto damage = model.consumeDamage();
    expect(damage.has_value(), "grid input produces damage");
    if (damage) {
        expect(damage->startRow >= 0 && damage->endRow <= model.rows() && damage->startCol >= 0 &&
                   damage->endCol <= model.columns() && damage->startRow < damage->endRow && damage->startCol < damage->endCol,
               "damage is clamped to the live grid");
    }
}

void testUnicodeCells() {
    TerminalModel model("unicode", "workspace-a", 8, 2);
    model.consumeDamage();
    model.input(std::string_view("e\xcc\x81\xe7\x95\x8c", 6));

    const TerminalCell combining = model.cell(0, 0);
    expect(combining.chars[0] == 'e' && combining.chars[1] == 0x301 && combining.width == 1,
           "combining codepoint remains attached to base glyph");
    const TerminalCell wide = model.cell(0, 1);
    expect(wide.chars[0] == 0x754c && wide.width == 2, "wide glyph preserves codepoint and cell width");
    expect(model.cell(0, 2).width == 0, "wide glyph continuation cell is marked width zero");
    expect(model.textBetween(SelectionPoint{0, 0}, SelectionPoint{0, 3}) ==
               std::string("e\xcc\x81\xe7\x95\x8c", 6),
           "wide glyph continuation does not leak libvterm's sentinel into selected UTF-8");
}

void testResizeAltScreenAndScrollback() {
    TerminalModel reflow("resize", "workspace-a", 5, 3);
    reflow.input("abcdefghij");
    reflow.resize(10, 3);
    expect(reflow.columns() == 10 && reflow.rows() == 3, "resize updates dimensions");
    expect(rowText(reflow, 0).find("abcdefghij") != std::string::npos ||
               (rowText(reflow, 0) + rowText(reflow, 1)).find("abcdefghij") != std::string::npos,
           "resize retains/reflows grid content");

    TerminalModel alternate("alternate", "workspace-a", 8, 2);
    alternate.input("primary");
    alternate.input("\x1b[?1049h");
    expect(alternate.modes().alternateScreen, "alternate screen mode enters");
    alternate.input("\x1b[Halt");
    expect(rowText(alternate, 0).starts_with("alt"), "alternate grid is active after explicitly homing the cursor");
    alternate.input("\x1b[?1049l");
    expect(!alternate.modes().alternateScreen, "alternate screen mode exits");
    expect(rowText(alternate, 0).starts_with("primary"), "primary grid is restored after alternate screen");

    TerminalModel history("history", "workspace-a", 6, 2, 2);
    history.input("one\r\ntwo\r\nthree\r\nfour");
    expect(history.scrollbackSize() == 2, "scrollback is a bounded ring");
    expect(history.lineCount() == history.scrollbackSize() + static_cast<std::size_t>(history.rows()),
           "scrollback and live grid form one absolute line space");
    const std::string selection = history.textBetween(SelectionPoint{0, 0}, SelectionPoint{history.lineCount() - 1, 6});
    expect(selection.find("two") != std::string::npos && selection.find("four") != std::string::npos,
           "selection spans scrollback and live screen");
}

void testOsc52() {
    TerminalModel model("osc", "workspace-a", 8, 2);
    std::string received;
    VTermSelectionMask receivedMask = static_cast<VTermSelectionMask>(0);
    model.setOsc52Callbacks(
        [&](VTermSelectionMask mask, std::string_view value) {
            receivedMask = mask;
            received.assign(value);
        },
        [](VTermSelectionMask) { return std::string("answer\0bytes", 12); });

    model.input("\x1b]52;c;aGVsbG8=\x07");
    expect(received == "hello", "OSC52 set is base64-decoded by libvterm without text conversion");
    expect((receivedMask & VTERM_SELECTION_CLIPBOARD) != 0, "OSC52 selection mask is preserved");

    std::string output;
    model.setOutputCallback([&](std::span<const std::uint8_t> value) { output.append(bytes(value)); });
    model.input("\x1b]52;c;?\x07");
    expect(output.find("YW5zd2VyAGJ5dGVz") != std::string::npos, "OSC52 query reply base64-encodes exact bytes including NUL");
}

void testKeyPasteAndMouseSequences() {
    TerminalModel model("input", "workspace-a", 20, 4);
    std::string output;
    model.setOutputCallback([&](std::span<const std::uint8_t> value) { output.append(bytes(value)); });

    model.key(VTERM_KEY_UP);
    expect(output == "\x1b[A", "arrow key sequence is encoded by libvterm");
    output.clear();
    model.character('c', VTERM_MOD_CTRL);
    expect(output == std::string(1, '\x03'), "Ctrl+C is forwarded as ETX");
    model.input("\x1b[?25l\x1b[3 q\x1b[?1004h");
    expect(!model.modes().cursorVisible &&
               model.modes().cursorShape == chud::terminal::TerminalModes::CursorShape::Underline &&
               model.modes().focusReporting,
           "cursor visibility/shape and focus reporting modes are tracked");
    output.clear();
    model.focus(true);
    model.focus(false);
    expect(output == "\x1b[I\x1b[O", "focus mode emits focus-in and focus-out sequences");

    model.input("\x1b[?2004h");
    output.clear();
    model.paste(std::string("x\0y", 3));
    expect(output == std::string("\x1b[200~x\0y\x1b[201~", 15), "bracketed paste preserves exact bytes and delimiters");

    model.input("\x1b[?1000;1006h");
    expect(model.modes().mouse == chud::terminal::TerminalModes::Mouse::Click && model.modes().sgrMouse,
           "click tracking plus SGR protocol is recognized");
    output.clear();
    expect(model.mouseMove(1, 2), "SGR mouse accepts position");
    expect(model.mouseButton(1, true), "SGR mouse accepts press");
    expect(model.mouseButton(1, false), "SGR mouse accepts release");
    expect(output == "\x1b[<0;3;2M\x1b[<0;3;2m", "mouse uses SGR press/release encoding only");

    model.input("\x1b[?1006l");
    output.clear();
    expect(!model.mouseButton(1, true) && output.empty(), "legacy mouse protocol is not forwarded");
}

void testDamageBoundsAfterResize() {
    TerminalModel model("damage", "workspace-a", 3, 2);
    model.consumeDamage();
    model.input("\x1b[999;999Hhello");
    const auto damage = model.consumeDamage();
    expect(damage.has_value(), "out-of-range cursor movement still damages a valid cell");
    if (damage) {
        expect(damage->startRow >= 0 && damage->endRow <= 2 && damage->startCol >= 0 && damage->endCol <= 3,
               "damage never escapes pre-resize bounds");
    }
    model.resize(1, 1);
    const auto resized = model.consumeDamage();
    expect(resized && resized->startRow == 0 && resized->endRow == 1 && resized->startCol == 0 && resized->endCol == 1,
           "resize invalidates exactly the new bounded screen");
    const VTermPos resizedCursor = model.cursor();
    expect(resizedCursor.row == 0 && resizedCursor.col == 0, "shrinking a wrapped cursor line keeps the cursor in bounds");
}

void testMultipleModelsAndQueuedProtocol() {
    std::string writeId;
    std::string writeBytes;
    std::string resizeId;
    int resizeColumns = 0;
    int resizeRows = 0;
    std::string closeId;
    TerminalModels models(TerminalProtocolCallbacks{
        .write = [&](std::string_view id, std::span<const std::uint8_t> value) {
            writeId = id;
            writeBytes.assign(bytes(value));
        },
        .resize = [&](std::string_view id, int columns, int rows) {
            resizeId = id;
            resizeColumns = columns;
            resizeRows = rows;
        },
        .close = [&](std::string_view id) { closeId = id; },
    });
    models.create("a", "project-one", 4, 2);
    models.create("b", "project-two", 4, 2);
    expect(models.size() == 2 && models.find("a")->workspaceId() == "project-one" &&
               models.find("b")->workspaceId() == "project-two",
           "terminal models are independently keyed and project-associated");

    models.enqueueDataBase64("a", "QQ==");
    models.enqueueDataBase64("b", "Qg==");
    models.enqueueDataBase64("b", "not base64");
    const auto processed = models.processPending();
    expect(processed.applied == 2 && processed.rejected == 1, "queued network data is applied/rejected on main-thread drain");
    expect(models.find("a")->cell(0, 0).chars[0] == 'A' && models.find("b")->cell(0, 0).chars[0] == 'B',
           "queued base64 routes to the matching terminal only");

    models.find("b")->character('c', VTERM_MOD_CTRL);
    expect(writeId == "b" && writeBytes == std::string(1, '\x03'), "terminal output callback identifies exact model and bytes");
    expect(models.resize("a", 9, 3) && resizeId == "a" && resizeColumns == 9 && resizeRows == 3,
           "resize callback stays synchronized with local model");

    models.enqueueExit("a", 17, "TERM");
    const auto exitProcessed = models.processPending();
    expect(exitProcessed.applied == 1 && models.find("a")->exited() && models.find("a")->exitCode() == 17 &&
               models.find("a")->exitSignal() == "TERM",
           "terminal exit event retains code and signal");
    expect(models.close("a") && closeId == "a" && models.find("a") == nullptr,
           "close callback fires and removes only the requested model");
}

}  // namespace

int main() {
    testBase64();
    testGridAndAttributes();
    testUnicodeCells();
    testResizeAltScreenAndScrollback();
    testOsc52();
    testKeyPasteAndMouseSequences();
    testDamageBoundsAfterResize();
    testMultipleModelsAndQueuedProtocol();

    if (failures != 0) {
        std::cerr << failures << " terminal test(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "terminal tests passed\n";
    return EXIT_SUCCESS;
}
