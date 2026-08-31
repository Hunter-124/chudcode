#include "copilot/copilot_view.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "copilot/image_textures.h"
#include "graph/session_dag.h"
#include "icons/icons.h"

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

// --- image fixtures ---------------------------------------------------------

void putBe32(std::vector<unsigned char>& out, std::uint32_t value) {
    out.push_back(static_cast<unsigned char>(value >> 24));
    out.push_back(static_cast<unsigned char>(value >> 16));
    out.push_back(static_cast<unsigned char>(value >> 8));
    out.push_back(static_cast<unsigned char>(value));
}

void pngChunk(std::vector<unsigned char>& png, const char* tag,
              const std::vector<unsigned char>& data) {
    putBe32(png, static_cast<std::uint32_t>(data.size()));
    png.insert(png.end(), tag, tag + 4);
    png.insert(png.end(), data.begin(), data.end());
    putBe32(png, 0);  // CRC: stb_image does not verify chunk CRCs
}

// Minimal valid 8-bit RGBA PNG (stored-deflate zlib, filter 0). `shade`
// varies the pixels so distinct attachments hash to distinct cache keys.
std::vector<unsigned char> encodePng(int width, int height, unsigned char shade) {
    std::vector<unsigned char> scan;
    for (int y = 0; y < height; ++y) {
        scan.push_back(0);  // filter 0
        for (int x = 0; x < width * 4; ++x) scan.push_back(shade);
    }
    std::vector<unsigned char> idat = {0x78, 0x01};
    const std::size_t len = scan.size();
    idat.push_back(1);  // final stored block
    idat.push_back(static_cast<unsigned char>(len & 0xFF));
    idat.push_back(static_cast<unsigned char>(len >> 8));
    idat.push_back(static_cast<unsigned char>(~len & 0xFF));
    idat.push_back(static_cast<unsigned char>((~len >> 8) & 0xFF));
    idat.insert(idat.end(), scan.begin(), scan.end());
    // adler32 over the raw scanline bytes; stb tolerates it either way but a
    // correct trailer keeps the fixture a genuinely valid PNG.
    std::uint32_t a = 1;
    std::uint32_t b = 0;
    for (const unsigned char byte : scan) {
        a = (a + byte) % 65521U;
        b = (b + a) % 65521U;
    }
    putBe32(idat, (b << 16) | a);

    std::vector<unsigned char> png = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
    std::vector<unsigned char> ihdr;
    putBe32(ihdr, static_cast<std::uint32_t>(width));
    putBe32(ihdr, static_cast<std::uint32_t>(height));
    ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});
    pngChunk(png, "IHDR", ihdr);
    pngChunk(png, "IDAT", idat);
    pngChunk(png, "IEND", {});
    return png;
}

std::string encodeBase64(const std::vector<unsigned char>& bytes) {
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    for (std::size_t index = 0; index < bytes.size(); index += 3) {
        const std::uint32_t one = bytes[index];
        const std::uint32_t two = index + 1 < bytes.size() ? bytes[index + 1] : 0;
        const std::uint32_t three = index + 2 < bytes.size() ? bytes[index + 2] : 0;
        const std::uint32_t packed = (one << 16) | (two << 8) | three;
        output.push_back(alphabet[(packed >> 18) & 63]);
        output.push_back(alphabet[(packed >> 12) & 63]);
        output.push_back(index + 1 < bytes.size() ? alphabet[(packed >> 6) & 63] : '=');
        output.push_back(index + 2 < bytes.size() ? alphabet[packed & 63] : '=');
    }
    return output;
}

ImageContent pngAttachment(unsigned char shade, int width = 2, int height = 2) {
    return {encodeBase64(encodePng(width, height, shade)), "image/png"};
}

struct CountingBackend {
    int uploads = 0;
    int destroys = 0;
    std::set<ImTextureID> live;
    ImTextureID next = 500;

    icons::TextureBackend backend() {
        return {
            [this](const unsigned char* rgba, int width, int height) -> ImTextureID {
                check(rgba != nullptr && width > 0 && height > 0,
                      "backend upload received an invalid image");
                ++uploads;
                const ImTextureID id = next++;
                live.insert(id);
                return id;
            },
            [this](ImTextureID id) {
                ++destroys;
                check(live.erase(id) == 1, "double or foreign texture destroy");
            },
        };
    }
};

session_graph::SessionDagNode agentNode(std::string id, std::string parent,
                                        std::string reference, bool orphan,
                                        bool recoverable) {
    session_graph::SessionDagNode node;
    node.id = std::move(id);
    node.parentId = std::move(parent);
    node.referenceId = std::move(reference);
    node.label = node.referenceId;
    node.kind = session_graph::NodeKind::Agent;
    node.orphan = orphan;
    node.recoverable = recoverable;
    return node;
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

void testAgentHierarchyGrouping() {
    session_graph::SessionDag dag;
    session_graph::SessionDagNode root;
    root.id = "session:root";
    root.referenceId = "/session";
    root.label = "Session";
    root.kind = session_graph::NodeKind::Session;
    dag.nodes.push_back(root);
    dag.nodes.push_back(agentNode("agent:main", "session:root", "main", false, false));
    dag.nodes.push_back(agentNode("agent:child", "agent:main", "child", false, true));
    dag.nodes.push_back(agentNode("agent:grand", "agent:child", "grand", false, false));
    dag.nodes.push_back(agentNode("agent:child2", "agent:main", "child2", false, false));
    dag.nodes.push_back(agentNode("agent:lost", "session:root", "lost", true, true));

    const std::vector<AgentTreeRow> rows = agentHierarchy(dag);
    check(rows.size() == 5, "hierarchy dropped or invented agents");
    check(rows[0].agentId == "main" && rows[0].depth == 0 && !rows[0].lastChild,
          "main agent was not the first root");
    check(rows[1].agentId == "child" && rows[1].depth == 1 && !rows[1].lastChild &&
              rows[1].trunkMask == 0x1,
          "first child was not grouped under its parent");
    check(rows[1].recoverable, "recoverable flag was lost in flattening");
    check(rows[2].agentId == "grand" && rows[2].depth == 2 && rows[2].lastChild &&
              rows[2].trunkMask == 0x3,
          "grandchild depth/trunk state was wrong");
    check(rows[3].agentId == "child2" && rows[3].depth == 1 && rows[3].lastChild &&
              rows[3].trunkMask == 0x1,
          "second child was not the last sibling under main");
    check(rows[4].agentId == "lost" && rows[4].depth == 0 && rows[4].orphan &&
              rows[4].recoverable && rows[4].lastChild,
          "orphan root lost its orphan/recoverable state");

    // A self-parented agent must terminate as a root, and a mutual parent
    // cycle must terminate (unreachable rows beat an infinite loop).
    session_graph::SessionDag degenerate;
    degenerate.nodes.push_back(agentNode("agent:self", "agent:self", "self", false, false));
    degenerate.nodes.push_back(agentNode("agent:a", "agent:b", "a", false, false));
    degenerate.nodes.push_back(agentNode("agent:b", "agent:a", "b", false, false));
    const std::vector<AgentTreeRow> loops = agentHierarchy(degenerate);
    check(loops.size() == 1 && loops[0].agentId == "self" && loops[0].depth == 0,
          "degenerate parent links were not contained");
}

void testUsageGaugeThresholds() {
    const auto usage = [](std::int64_t tokens, std::int64_t window) {
        return ContextUsage{tokens, window, std::nullopt};
    };
    check(usageLevel(usage(20000, 200000)) == UsageLevel::Ok,
          "10% of a standard window was not Ok");
    check(usageLevel(usage(100000, 200000)) == UsageLevel::Warn,
          "50% did not reach the amber compaction tier");
    check(usageLevel(usage(99000, 200000)) == UsageLevel::Ok,
          "just under 50% was already amber");
    check(usageLevel(usage(180000, 200000)) == UsageLevel::Err,
          "90% did not reach the red capacity tier");
    // Token clamps: a giant window goes amber/red on absolute pressure while
    // its percentage still looks small (min(percent, tokens) semantics).
    check(usageLevel(usage(150000, 1000000)) == UsageLevel::Warn,
          "150k tokens in a 1M window was not amber");
    check(usageLevel(usage(500000, 1000000)) == UsageLevel::Err,
          "500k tokens in a 1M window was not red");
    check(usageLevel(usage(100000, 1000000)) == UsageLevel::Ok,
          "100k tokens in a 1M window was not Ok");

    // Percent-only reports (window unknown) use pure percent thresholds.
    check(usageLevel(ContextUsage{std::nullopt, std::nullopt, 55.0}) == UsageLevel::Warn,
          "percent-only 55% was not amber");
    check(usageLevel(ContextUsage{std::nullopt, std::nullopt, 95.0}) == UsageLevel::Err,
          "percent-only 95% was not red");

    // Nothing known → Unknown, honest label, no fraction claim.
    check(usageLevel(ContextUsage{}) == UsageLevel::Unknown,
          "empty usage was not Unknown");
    check(!usageFraction(ContextUsage{}).has_value(),
          "unknown usage claimed a fraction");
    check(usageLabel(ContextUsage{}) == "context usage unknown",
          "unknown usage label was not honest");
    check(usageLabel(ContextUsage{12345, std::nullopt, std::nullopt}) ==
              "12.3k tokens / window unknown",
          "tokens-without-window label was wrong");
    check(usageLabel(usage(100000, 200000)) == "50.0% of 200.0k",
          "known-window label was wrong");
    const auto fraction = usageFraction(usage(50000, 200000));
    check(fraction && *fraction > 0.249 && *fraction < 0.251,
          "usage fraction was not tokens/window");
}

void testImageDecoderAndCacheLifecycle() {
    // Decoder: a real 2x2 PNG round-trips through base64 into RGBA8.
    const ImageContent attachment = pngAttachment(0x40);
    const auto bytes = decodeBase64(attachment.data);
    check(bytes.has_value(), "canonical base64 did not decode");
    const DecodedImage decoded = decodeImageBytes(bytes->data(), bytes->size());
    check(decoded.valid() && decoded.width == 2 && decoded.height == 2,
          "valid PNG bytes did not decode to 2x2 RGBA");
    check(decoded.rgba[0] == 0x40, "decoded pixel value was wrong");
    check(!decodeBase64("not base64 !!").has_value(), "garbage base64 was accepted");
    check(!decodeBase64("AB=C").has_value(), "misplaced padding was accepted");

    // Cache: hits do not re-upload; the bound evicts LRU; clear releases all.
    CountingBackend counting;
    {
        ImageTextureCache cache(counting.backend(), 2);
        const ImageTexture first = cache.acquire(attachment);
        check(first.valid && first.width == 2 && first.height == 2,
              "first acquire did not upload a texture");
        check(counting.uploads == 1, "first acquire uploaded more than once");
        const ImageTexture again = cache.acquire(attachment);
        check(again.valid && again.texture == first.texture && counting.uploads == 1,
              "cache hit re-uploaded");
        (void)cache.acquire(pngAttachment(0x41));
        check(counting.uploads == 2 && counting.destroys == 0,
              "second attachment did not fit the bound");
        (void)cache.acquire(pngAttachment(0x42));
        check(counting.uploads == 3 && counting.destroys == 1 &&
                  cache.textureCount() == 2,
              "texture bound was not enforced by LRU eviction");
        cache.clear();
        check(counting.live.empty() && cache.textureCount() == 0 &&
                  cache.entryCount() == 0,
              "clear did not release every texture");
    }
    check(counting.uploads == counting.destroys,
          "cache leaked textures across its lifetime");
}

void testMissingImageFallback() {
    CountingBackend counting;
    ImageTextureCache cache(counting.backend(), 4);

    // Not base64 at all.
    const ImageTexture garbage = cache.acquire({"!!definitely not base64!!", "image/png"});
    check(!garbage.valid && garbage.texture == 0, "undecodable base64 claimed pixels");
    check(counting.uploads == 0, "invalid payload reached the GPU backend");

    // Valid base64, but not an image; the failure is cached, not re-decoded.
    const ImageContent broken{encodeBase64({'h', 'e', 'l', 'l', 'o'}), "image/png"};
    check(!cache.acquire(broken).valid, "non-image bytes claimed pixels");
    const std::size_t entries = cache.entryCount();
    check(!cache.acquire(broken).valid && cache.entryCount() == entries,
          "failed decode was not remembered");

    // Empty attachments produce no cache entry at all.
    check(!cache.acquire(ImageContent{}).valid, "empty attachment claimed pixels");
    check(cache.entryCount() == entries, "empty attachment grew the cache");
    check(counting.uploads == 0 && counting.destroys == 0,
          "fallback paths touched the texture backend");
}

void testActionIconLookup() {
    const Action actions[] = {
        Action::Send,          Action::Stop,          Action::AttachImage,
        Action::RemoveAttachment, Action::NewSession, Action::OpenSession,
        Action::RenameSession, Action::ForkSession,   Action::PinSession,
        Action::DeleteSession, Action::AgentMessage,  Action::AgentTranscript,
        Action::AgentRevive,   Action::AgentKill,
    };
    for (const Action action : actions) {
        const char* name = actionIconName(action);
        check(name != nullptr && *name != '\0', "action mapped to no icon name");
        const bool known = std::any_of(
            icons::kIconNames.begin(), icons::kIconNames.end(),
            [&](const char* candidate) { return std::string_view(candidate) == name; });
        check(known, (std::string("action icon '") + name +
                      "' is not in the atlas inventory")
                         .c_str());
    }
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
        testAgentHierarchyGrouping();
        testUsageGaugeThresholds();
        testImageDecoderAndCacheLifecycle();
        testMissingImageFallback();
        testActionIconLookup();
        std::cout << "copilot tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "copilot test failure: " << error.what() << '\n';
        return 1;
    }
}
