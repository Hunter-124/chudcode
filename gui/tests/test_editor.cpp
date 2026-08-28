#include "editor/editor.h"

#include <cassert>
#include <iostream>
#include <string>
#include <utility>

using namespace chud::editor;

namespace {

FileStamp stamp(std::string sha, std::uint64_t generation = 1) {
    return {std::move(sha), 12, 100, generation};
}

Snapshot snapshot(std::string uri, std::string text, std::string sha = "base") {
    return {uri, uri, "cpp", std::move(text), stamp(std::move(sha))};
}

void testDocumentConflictAndRegions() {
    EditorPanel panel;
    panel.acceptSnapshot(snapshot("file:///a.cpp", "one\ntwo\nthree\n"));
    panel.replaceText("file:///a.cpp", "one\nlocal\nthree\n");
    auto* document = panel.document("file:///a.cpp");
    assert(document && document->dirty && !document->conflict);

    panel.fileChanged("file:///a.cpp", ChangeOrigin::External, stamp("remote", 2));
    assert(document->dirty);
    assert(document->conflict);
    assert(document->status == DocumentStatus::Conflict);

    assert((EditorPanel::changedLines("a\nb\nc", "a\nx\nc") == LineRegion{1, 1}));
    assert((EditorPanel::changedLines("a\nb\nc", "a\nx\ny\nc") == LineRegion{1, 2}));
    assert((EditorPanel::changedLines("a\nb\nc", "a\nc") == LineRegion{1, 1}));
}

void testTabsAndViewPersistence() {
    EditorPanel panel;
    panel.acceptSnapshot(snapshot("file:///one.cpp", "one"));
    panel.acceptSnapshot(snapshot("file:///two.cpp", "two"));
    assert(panel.tabs().size() == 2);
    assert(panel.activate("file:///one.cpp"));

    ViewState view;
    view.cursor = {8, 5, 7, 2};
    view.firstVisibleLine = 4;
    view.wordWrap = true;
    panel.setView("file:///one.cpp", view);
    panel.acceptSnapshot(snapshot("file:///one.cpp", "remote", "next"), true);
    assert(panel.document("file:///one.cpp")->view == view);

    panel.replaceText("file:///one.cpp", "dirty");
    assert(!panel.close("file:///one.cpp"));
    assert(panel.close("file:///one.cpp", true));
    assert(panel.tabs().size() == 1);
    assert(panel.activeUri() == "file:///two.cpp");
}

void testCasTransitionsAndConcurrentTyping() {
    EditorRequests requests;
    EditorRequests::WriteCallback pendingWrite;
    std::string expected;
    std::string written;
    requests.write = [&](std::string, std::string, std::string text,
                         std::string expectedSha, EditorRequests::WriteCallback callback) {
        written = std::move(text);
        expected = std::move(expectedSha);
        pendingWrite = std::move(callback);
    };

    EditorPanel panel(std::move(requests));
    panel.acceptSnapshot(snapshot("file:///save.cpp", "base", "sha-1"));
    panel.replaceText("file:///save.cpp", "first edit");
    panel.save();
    assert(panel.document("file:///save.cpp")->status == DocumentStatus::Saving);
    assert(expected == "sha-1");
    assert(written == "first edit");

    // A successful CAS saves exactly the captured revision; later typing remains dirty.
    panel.replaceText("file:///save.cpp", "second edit");
    pendingWrite(stamp("sha-2", 2));
    panel.processCallbacks();
    auto* document = panel.document("file:///save.cpp");
    assert(document->stamp.sha256 == "sha-2");
    assert(document->baseText == "first edit");
    assert(document->text == "second edit");
    assert(document->dirty);
    assert(document->status == DocumentStatus::Ready);

    panel.save();
    pendingWrite(RequestError{"cas-conflict", "changed on disk"});
    panel.processCallbacks();
    assert(document->conflict);
    assert(document->status == DocumentStatus::Conflict);
}

void testCleanWatcherReloadAndConflictResolution() {
    EditorRequests requests;
    EditorRequests::ReadCallback pendingRead;
    requests.read = [&](std::string, std::string, EditorRequests::ReadCallback callback) {
        pendingRead = std::move(callback);
    };
    EditorPanel panel(std::move(requests));
    panel.acceptSnapshot(snapshot("file:///watch.cpp", "old\ntext", "old"));
    ViewState view;
    view.cursor = {1, 2, 1, 2};
    view.firstVisibleLine = 1;
    panel.setView("file:///watch.cpp", view);

    panel.fileChanged("file:///watch.cpp", ChangeOrigin::Agent, stamp("new", 2));
    assert(panel.document("file:///watch.cpp")->status == DocumentStatus::Loading);
    pendingRead(snapshot("file:///watch.cpp", "old\nagent text", "new"));
    panel.processCallbacks();
    auto* document = panel.document("file:///watch.cpp");
    assert(document->text == "old\nagent text");
    assert(!document->dirty && !document->conflict);
    assert(document->view == view);
    assert(document->flash.active);
    assert((document->flash.region == LineRegion{1, 1}));

    panel.replaceText("file:///watch.cpp", "local");
    panel.fileChanged("file:///watch.cpp", ChangeOrigin::External, stamp("remote", 3));
    assert(document->conflict);
    panel.keepLocalAgainstLatest();
    pendingRead(snapshot("file:///watch.cpp", "remote", "remote"));
    panel.processCallbacks();
    assert(document->text == "local");
    assert(document->baseText == "remote");
    assert(document->dirty && !document->conflict);
}

void testLspRangeConversion() {
    const std::string line = "a\xF0\x9F\x98\x80z"; // a, U+1F600 (two UTF-16 units), z
    assert(EditorPanel::utf16ColumnToGlyph(line, 0) == 0);
    assert(EditorPanel::utf16ColumnToGlyph(line, 1) == 1);
    assert(EditorPanel::utf16ColumnToGlyph(line, 2) == 1); // never split a surrogate pair
    assert(EditorPanel::utf16ColumnToGlyph(line, 3) == 2);
    assert(EditorPanel::utf16ColumnToGlyph(line, 4) == 3);
    assert(EditorPanel::glyphToUtf16Column(line, 0) == 0);
    assert(EditorPanel::glyphToUtf16Column(line, 1) == 1);
    assert(EditorPanel::glyphToUtf16Column(line, 2) == 3);
    assert(EditorPanel::glyphToUtf16Column(line, 3) == 4);
}

void testLspRequestCallbacks() {
    EditorRequests requests;
    LspRequest captured;
    EditorRequests::LspCallback pending;
    requests.lsp = [&](LspRequest request, EditorRequests::LspCallback callback) {
        captured = std::move(request);
        pending = std::move(callback);
    };
    EditorPanel panel(std::move(requests));
    panel.setWorkspace("workspace");
    panel.acceptSnapshot(snapshot("file:///lsp.cpp", "a\xF0\x9F\x98\x80z"));
    ViewState view;
    view.cursor = {0, 2, 0, 2};
    panel.setView("file:///lsp.cpp", view);

    bool delivered = false;
    panel.setLspResultHandler([&](LspFeature feature, Result<LspValue> result) {
        delivered = feature == LspFeature::Definition && std::holds_alternative<LspValue>(result);
    });
    panel.requestDefinition();
    assert(captured.workspaceId == "workspace");
    assert(captured.uri == "file:///lsp.cpp");
    assert((captured.position == Position{0, 3}));
    pending(LspValue{std::vector<Location>{{"file:///target.cpp", {{2, 1}, {2, 4}}}}});
    panel.processCallbacks();
    assert(delivered);
}

void testFallbackPolicyAndFlashLifecycle() {
    assert(EditorPanel::fallbackFor("plain text") == FallbackMode::None);
    assert(EditorPanel::fallbackFor(std::string("a\0b", 3)) == FallbackMode::Binary);
    assert(EditorPanel::fallbackFor(std::string(EditorPanel::kMaximumEditableLineBytes + 1, 'x')) ==
           FallbackMode::LongLine);
    const std::string invalid("\xC3\x28", 2);
    assert(EditorPanel::fallbackFor(invalid) == FallbackMode::Binary);

    EditorPanel panel;
    panel.acceptSnapshot(snapshot("file:///flash.cpp", "before"));
    panel.acceptSnapshot(snapshot("file:///flash.cpp", "after", "agent"), true, ChangeOrigin::Agent);
    auto* document = panel.document("file:///flash.cpp");
    assert(document->flash.active);
    const float duration = document->flash.remainingSeconds;
    panel.advanceAnimations(duration * 0.5F);
    assert(document->flash.active);
    assert(document->flash.remainingSeconds < duration);
    panel.advanceAnimations(duration);
    assert(!document->flash.active);
    assert(document->flash.remainingSeconds == 0.0F);
}

} // namespace

int main() {
    testDocumentConflictAndRegions();
    testTabsAndViewPersistence();
    testCasTransitionsAndConcurrentTyping();
    testCleanWatcherReloadAndConflictResolution();
    testLspRangeConversion();
    testLspRequestCallbacks();
    testFallbackPolicyAndFlashLifecycle();
    std::cout << "editor tests passed\n";
    return 0;
}
