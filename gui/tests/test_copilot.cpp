#include "copilot/copilot_view.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace chud;
using namespace chud::copilot;

namespace {

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

SessionState idleState(bool streaming = false) {
    return {streaming, 0, std::nullopt, "/project", std::nullopt, std::nullopt,
            std::nullopt, {}, false};
}

SessionEntry entry(SessionEntryKind kind, std::string id, Json payload) {
    return {kind, std::move(id), std::nullopt, "2026-08-27T00:00:00Z",
            std::move(payload)};
}

void welcome(DesktopStore& store, std::string path, bool streaming = false) {
    store.apply(EventFrame{WelcomeEvent{
        path, 1, SessionHeader{path, path, "now", "/project"}, idleState(streaming), {}, 0}});
}

struct Call {
    std::string method;
    Json params;
};

CopilotActions actionsRecording(std::vector<Call>& calls) {
    return {[&](std::string method, Json params, CopilotActions::Response response) {
        calls.push_back({method, params});
        if (!response) return;
        if (method == "prompt.send") {
            response(ResponseFrame{1, method, Json{{"accepted", true}}, std::nullopt});
        } else if (method == "agent.transcript") {
            response(ResponseFrame{1, method,
                                   Json{{"text", "agent output"}, {"newSize", 12}},
                                   std::nullopt});
        }
    }};
}

void applyUserEdit(SoftWrappedText& text, std::string edited, std::size_t cursor) {
    text.recordEdit(edited, cursor);
    text.applyEdited(std::move(edited));
}

void testHardBreakTrackingAndCopyNormalization() {
    const std::string source = "alpha beta\ngamma delta";
    SoftWrappedText text(source, 7);
    check(text.displayText().size() == source.size(), "wrapping changed byte length");
    check(text.canonicalText() == source, "soft wrapping changed canonical text");
    check(text.hardBreakOffsets() == std::vector<std::size_t>{10},
          "authored newline provenance was lost");
    check(!text.softBreakOffsets().empty(), "expected a soft break");
    check(text.copyRange(0, text.displayText().size()) == source,
          "copy did not remove only soft wrapping");

    std::string edited = text.displayText();
    edited.insert(5, 1, '\n');
    applyUserEdit(text, std::move(edited), 6);
    check(text.canonicalText() == "alpha\n beta\ngamma delta",
          "typed newline was not retained as a hard break");
    check(text.hardBreakOffsets() == std::vector<std::size_t>({5, 11}),
          "typed hard break offsets were not tracked and sorted");

    SoftWrappedText shifted("ab\ncd");
    edited = shifted.displayText();
    edited.insert(0, 1, 'X');
    applyUserEdit(shifted, std::move(edited), 1);
    check(shifted.hardBreakOffsets() == std::vector<std::size_t>{3},
          "insertion before a hard break did not shift it");
    edited = shifted.displayText();
    edited.push_back('Y');
    applyUserEdit(shifted, std::move(edited), shifted.displayText().size() + 1);
    check(shifted.hardBreakOffsets() == std::vector<std::size_t>{3},
          "insertion after a hard break shifted it");
    edited = shifted.displayText();
    edited.pop_back();
    applyUserEdit(shifted, std::move(edited), shifted.displayText().size() - 1);
    check(shifted.hardBreakOffsets() == std::vector<std::size_t>{3},
          "deletion after a hard break shifted it");
    edited = shifted.displayText();
    edited.erase(0, 1);
    applyUserEdit(shifted, std::move(edited), 0);
    check(shifted.canonicalText() == "ab\ncd" &&
              shifted.hardBreakOffsets() == std::vector<std::size_t>{2},
          "deletion before a hard break did not shift it");

    SoftWrappedText backspace("ab\ncd");
    edited = backspace.displayText();
    edited.erase(2, 1);
    applyUserEdit(backspace, std::move(edited), 2);
    check(backspace.canonicalText() == "abcd" && backspace.hardBreakOffsets().empty(),
          "backspacing a hard break did not drop it");

    SoftWrappedText selection("a\nbc\nde");
    edited = selection.displayText();
    edited.erase(0, 3);
    applyUserEdit(selection, std::move(edited), 0);
    check(selection.canonicalText() == "c\nde" &&
              selection.hardBreakOffsets() == std::vector<std::size_t>{1},
          "selection deletion did not drop and shift spanned hard breaks");

    SoftWrappedText pasted("ab\ncd");
    edited = pasted.displayText();
    edited.insert(1, "x\ny\n");
    applyUserEdit(pasted, std::move(edited), 5);
    check(pasted.canonicalText() == "ax\ny\nb\ncd",
          "multiline paste did not retain inserted newlines");
    check(pasted.hardBreakOffsets() == std::vector<std::size_t>({2, 4, 6}),
          "multiline paste hard break offsets were not sorted");

    SoftWrappedText wrapperSwap("alpha beta");
    edited = wrapperSwap.displayText();
    edited[5] = '\n';
    applyUserEdit(wrapperSwap, std::move(edited), 6);
    check(wrapperSwap.canonicalText() == "alpha beta" &&
              wrapperSwap.hardBreakOffsets().empty(),
          "same-length wrapper swap invented a hard break");

    SoftWrappedText external("old");
    external.applyEdited("new\nvalue");
    check(external.canonicalText() == "new\nvalue" &&
              external.hardBreakOffsets() == std::vector<std::size_t>{3},
          "external length change did not reseed authored newlines");

    SoftWrappedText undoable("alpha beta", 7);
    const std::string wrappedBeforeDelete = undoable.displayText();
    const std::size_t softBreak = undoable.softBreakOffsets().front();
    edited = wrappedBeforeDelete;
    edited.erase(softBreak, 1);
    applyUserEdit(undoable, std::move(edited), softBreak);
    applyUserEdit(undoable, wrappedBeforeDelete, softBreak + 1);
    check(undoable.canonicalText() == "alpha beta",
          "undo restored a soft break as an authored newline");

    const std::string canonical = text.canonicalText();
    text.setWrapColumns(4);
    check(text.displayText().size() == canonical.size(), "rewrap changed byte offsets");
    check(text.copyRange(0, text.displayText().size()) == canonical,
          "rewrap corrupted normalized copy");
}

void testPerSessionDraftSwitching() {
    DesktopStore store;
    store.apply(EventFrame{SessionTabsEvent{{
        {"/a", "A", "/", true, false, 0, false},
        {"/b", "B", "/", false, false, 0, false},
    }}});
    std::vector<Call> calls;
    CopilotView view(store, actionsRecording(calls));
    view.setSessionPath("/a");
    view.draft().setText("draft A", 5);
    view.setSessionPath("/b");
    view.draft().setText("draft B", 5);
    view.setSessionPath("/a");
    check(view.draft().text.canonicalText() == "draft A", "session A draft did not survive switch");
    view.setSessionPath("/b");
    check(view.draft().text.canonicalText() == "draft B", "session B draft crossed sessions");

    const auto tabs = view.sessionTabs();
    check(tabs.size() == 2 && tabs[0].draftDirty && tabs[1].draftDirty,
          "tab draft projection did not include controlled drafts");
}

void testSubmitAndStopTargets() {
    DesktopStore store;
    welcome(store, "/target", true);
    std::vector<Call> calls;
    CopilotView view(store, actionsRecording(calls));
    view.setSessionPath("/target");
    view.draft().setText("one two\nthree", 4);
    view.attachImage({"encoded", "image/png"});

    check(view.submit(), "submit was not dispatched");
    check(calls.size() >= 2, "draft notification and submit were not dispatched");
    const Call* submit = nullptr;
    for (const Call& call : calls)
        if (call.method == "prompt.send") submit = &call;
    check(submit != nullptr, "prompt.send was not targeted");
    check(submit->params.at("sessionPath") == "/target", "submit targeted the wrong session");
    check(submit->params.at("text") == "one two\nthree", "submit leaked visual soft breaks");
    check(submit->params.at("images").size() == 1, "submit dropped attached image");
    check(!view.draft().dirty(), "accepted submit did not clear only the target draft");

    check(view.stop(), "stop was not dispatched");
    check(calls.back().method == "run.abort" && calls.back().params.at("sessionPath") == "/target",
          "stop targeted the wrong session");
}

void testOrderedRowsAndActiveTools() {
    SessionSnapshot snapshot;
    snapshot.entries.push_back(entry(
        SessionEntryKind::Message, "u1",
        {{"type", "message"},
         {"message", {{"role", "user"}, {"content", "question"}, {"timestamp", 1}}}}));
    snapshot.entries.push_back(entry(
        SessionEntryKind::Message, "a1",
        {{"type", "message"},
         {"message",
          {{"role", "assistant"},
           {"model", "m"},
           {"content", Json::array({
                           {{"type", "thinking"}, {"thinking", "reason"}},
                           {{"type", "text"}, {"text", "answer"}},
                           {{"type", "toolCall"}, {"id", "tool-1"}, {"name", "read"},
                            {"arguments", Json::object()}},
                           {{"type", "toolCall"}, {"id", "tool-2"}, {"name", "write"},
                            {"intent", "update file"}, {"arguments", Json::object()}},
                       })},
           {"stopReason", "toolUse"},
           {"timestamp", 2}}}}));
    snapshot.entries.push_back(entry(
        SessionEntryKind::Message, "r1",
        {{"type", "message"},
         {"message",
          {{"role", "toolResult"}, {"toolCallId", "tool-1"}, {"toolName", "read"},
           {"content", Json::array({{{"type", "text"}, {"text", "ok"}}})},
           {"isError", false}, {"timestamp", 3}}}}));
    snapshot.entries.push_back(entry(
        SessionEntryKind::CustomMessage, "task-1",
        {{"type", "custom_message"}, {"customType", "todo_update"},
         {"content", "Ship it"}, {"display", true}, {"state", "doing"},
         {"phase", "Delivery"}}));
    snapshot.latestAgentEvent = AgentEvent{"agent.status", {{"message", "delegated"}}};
    snapshot.state = idleState(true);
    snapshot.uiRequest = UiRequest{9, "ask", "Choose", {{"question", "Continue?"}}};

    const TranscriptProjection projection = TranscriptProjection::from(snapshot);
    check(projection.rows.size() == 10, "ordered projection omitted or duplicated a row");
    const std::vector<TranscriptKind> kinds{
        TranscriptKind::User, TranscriptKind::Thinking, TranscriptKind::Assistant,
        TranscriptKind::Tool, TranscriptKind::Tool, TranscriptKind::ToolResult,
        TranscriptKind::Task, TranscriptKind::Agent, TranscriptKind::Status,
        TranscriptKind::UiRequest};
    for (std::size_t index = 0; index < kinds.size(); ++index) {
        check(projection.rows[index].kind == kinds[index], "transcript row arrival order changed");
        check(projection.rows[index].order == index, "transcript order key is not monotonic");
    }
    check(projection.activeTools.size() == 1 && projection.activeTools[0].id == "tool-2",
          "resolved tool remained active or unresolved tool disappeared");
    check(projection.tasks.size() == 1 && projection.tasks[0].title == "Ship it",
          "todo projection was not populated");
}

void testScrollLockReleaseAndRelock() {
    ScrollLock lock;
    check(lock.shouldFollowAppend(), "transcript did not start bottom locked");
    lock.observe(40.0f, 100.0f, true);
    check(!lock.shouldFollowAppend(), "user scroll did not release bottom lock");
    lock.observe(60.0f, 120.0f, false);
    check(!lock.shouldFollowAppend(), "new content stole released scroll lock");
    lock.observe(119.0f, 120.0f, true);
    check(lock.shouldFollowAppend(), "returning to bottom did not restore lock");
}

void testAskResponseAndAgentCommands() {
    DesktopStore store;
    welcome(store, "/ask");
    store.apply(EventFrame{UiRequestEvent{
        "/ask", UiRequest{77, "ask", "Question", {{"question", "Pick one"}}}}});
    std::vector<Call> calls;
    CopilotView view(store, actionsRecording(calls));
    view.setSessionPath("/ask");

    check(view.respondToUi("choice-a"), "ask response was not dispatched");
    check(calls.back().method == "ui.respond" && calls.back().params.at("reqId") == 77 &&
              calls.back().params.at("value") == "choice-a" &&
              calls.back().params.at("sessionPath") == "/ask",
          "ask response payload was incorrect");

    check(view.commandAgent("agent-1", "chat", "hello"), "agent chat was not dispatched");
    check(calls.back().method == "agent.command" && calls.back().params.at("cmd") == "chat" &&
              calls.back().params.at("agentId") == "agent-1" &&
              calls.back().params.at("text") == "hello",
          "agent chat command payload was incorrect");
    check(view.commandAgent("agent-1", "kill"), "agent kill was not dispatched");
    check(view.commandAgent("agent-1", "revive"), "agent revive was not dispatched");
    check(!view.commandAgent("agent-1", "unknown"), "unknown agent command was accepted");
    check(view.requestAgentTranscript("agent-1"), "agent transcript was not requested");
    check(view.agentTranscript("agent-1") == "agent output", "agent transcript response was lost");
}

void testCloseGuards() {
    DesktopStore store;
    store.apply(EventFrame{SessionTabsEvent{{
        {"/running", "Running", "/", true, true, 0, false},
        {"/clean", "Clean", "/", false, false, 0, false},
    }}});
    std::vector<Call> calls;
    CopilotView view(store, actionsRecording(calls));
    view.draft("/running").setText("unsent");

    const CloseGuard guarded = view.closeGuard("/running");
    check(guarded.block == CloseBlock::RunningAndDraft && guarded.needsConfirmation(),
          "running dirty session did not expose both close guards");
    check(!view.closeSession("/running"), "guarded close dispatched without force");
    check(view.closeSession("/running", true), "forced close was not dispatched");
    check(calls.back().method == "session.tab.close" && calls.back().params.at("force") == true,
          "forced close payload was incorrect");
    check(view.closeGuard("/clean").canClose(), "clean stopped session was guarded");
    check(view.closeSession("/clean"), "clean close was not dispatched");
}

}  // namespace

int main() {
    try {
        testHardBreakTrackingAndCopyNormalization();
        testPerSessionDraftSwitching();
        testSubmitAndStopTargets();
        testOrderedRowsAndActiveTools();
        testScrollLockReleaseAndRelock();
        testAskResponseAndAgentCommands();
        testCloseGuards();
        std::cout << "copilot tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "copilot test failure: " << error.what() << '\n';
        return 1;
    }
}
