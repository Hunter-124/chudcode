#include <chrono>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "net/ws_transport.h"
#include "protocol/desktop_client.h"
#include "protocol/desktop_store.h"
#include "protocol/json_codec.h"

namespace {
using namespace chud;

void check(bool value, const char* message) {
    if(!value) throw std::runtime_error(message);
}
template <typename F>
void rejects(F&& function, const char* message) {
    try { function(); } catch(const std::exception&) { return; }
    throw std::runtime_error(message);
}

Json stateJson(std::string cwd) {
    return {{"isStreaming",false},{"queuedMessageCount",0},{"cwd",std::move(cwd)},
        {"model",{{"id","m"},{"name","Model"},{"provider","p"},{"contextWindow",nullptr}}},
        {"contextUsage",{{"tokens",nullptr},{"contextWindow",nullptr},{"percent",nullptr}}},
        {"participants",Json::array({{{"name","host"},{"role","host"}}})}};
}
Json entryJson(std::string id, std::string text) {
    return {{"type","message"},{"id",std::move(id)},{"parentId",nullptr},{"timestamp","2026-01-01T00:00:00Z"},
        {"message",{{"role","user"},{"content",std::move(text)},{"timestamp",1}}}};
}
EventFrame eventFrom(Json value) { return std::get<EventFrame>(json_codec::parseFrame(value.dump())); }

void testCodecRoundTrips() {
    DocumentSnapshot document{"d1","file:///a.cpp","cpp","int main(){}",{"abc",12,34,5},true,false};
    EventFrame frame{{DocumentEvent{document,ChangeOrigin::Agent}}};
    auto decoded=std::get<EventFrame>(json_codec::parseFrame(json_codec::encodeFrame(frame)));
    const auto& event=std::get<DocumentEvent>(decoded.payload);
    check(event.document==document,"document codec round-trip failed");
    check(event.origin==ChangeOrigin::Agent,"document origin round-trip failed");

    GraphSnapshot graph{7,{{"n","Node","symbol",std::string("g"),GraphState::Changing,{{"line",3.0},{"generated",false}}}},{{"e","n","n","self",GraphState::Stable}}};
    check(json_codec::parseGraphSnapshot(json_codec::encodeGraphSnapshot(graph))==graph,"graph codec round-trip failed");
    RequestFrame request{77,"workspace.write",{{"workspaceId","w"},{"uri","u"},{"text","x"},{"expectedSha256","h"}}};
    check(std::get<RequestFrame>(json_codec::parseFrame(json_codec::encodeFrame(request)))==request,"request codec round-trip failed");
    ResponseFrame response{77,"runtime.hello",Json{{"protocol",1},{"product","chudcode"}},std::nullopt};
    check(std::get<ResponseFrame>(json_codec::parseFrame(json_codec::encodeFrame(response)))==response,"response codec round-trip failed");

    Json additive={{"t","terminal-data"},{"terminalId","term"},{"dataBase64","AA=="},{"future",{{"nested",true}}}};
    check(std::holds_alternative<TerminalDataEvent>(eventFrom(additive).payload),"known event rejected additive field");
    auto unknown=eventFrom({{"t","future-event"},{"requiredByFuture",42}});
    check(std::get<UnknownEvent>(unknown.payload).raw.at("requiredByFuture")==42,"unknown event was not preserved");
    auto futureAgent=eventFrom({{"t","agent-event"},{"sessionPath","s"},{"event",{{"type","future-agent-event"},{"value",1}}}});
    check(std::get<AgentEventFrame>(futureAgent.payload).event.type=="future-agent-event","unknown agent event was not preserved");
    auto futureEntry=eventFrom({{"t","snapshot-chunk"},{"sessionPath","s"},{"final",true},{"entries",Json::array({
        {{"type","future_entry"},{"id","f"},{"parentId",nullptr},{"timestamp","t"},{"value",2}}
    })}});
    check(std::get<SnapshotChunkEvent>(futureEntry.payload).entries.front().kind==SessionEntryKind::Unknown,"unknown session entry was not preserved");

    rejects([] { json_codec::parseSessionState({{"queuedMessageCount",0},{"cwd","/"},{"participants",Json::array()}}); },"state missing isStreaming was accepted");
    rejects([] { json_codec::parseSessionState({{"isStreaming",false},{"queuedMessageCount",0},{"cwd","/"},{"contextUsage",{{"tokens",0},{"percent",0}}},{"participants",Json::array()}}); },"state missing required nullable contextWindow was accepted");

    Json badCost={{"t","snapshot-chunk"},{"sessionPath","s"},{"final",true},{"entries",Json::array({
        {{"type","message"},{"id","a"},{"parentId",nullptr},{"timestamp","t"},{"message",{
            {"role","assistant"},{"content",Json::array()},{"model","m"},{"stopReason","stop"},{"timestamp",1},
            {"usage",{{"input",1},{"output",2},{"cacheRead",0},{"cacheWrite",0},{"totalTokens",3},{"cost",Json::object()}}}
        }}}
    })}};
    rejects([&] { json_codec::parseFrame(badCost.dump()); },"assistant usage missing cost.total was accepted");
    rejects([] { json_codec::parseFrame(Json{{"t","request"},{"id",1},{"method","workspace.write"},{"params",{{"workspaceId","w"},{"uri","u"},{"text","x"}}}}.dump()); },
        "request missing expectedSha256 was accepted");
    rejects([] { json_codec::parseFrame(Json{{"t","response"},{"id",1},{"method","runtime.hello"},{"result",{{"protocol",1}}}}.dump()); },
        "response missing required product was accepted");

    check(json_codec::supportedMethods().size()==50,"current desktop request method inventory is incomplete");
    for(auto method:json_codec::supportedMethods())check(json_codec::isSupportedMethod(method),"advertised method is unsupported");
}

void testOrderedSessionsAndStoreProjection() {
    DesktopStore store;
    auto welcome=[&](std::string path,std::string id) {
        return eventFrom({{"t","welcome"},{"sessionPath",path},{"protocol",1},
            {"header",{{"type","session"},{"id",id},{"timestamp","now"},{"cwd","/tmp"}}},
            {"state",stateJson("/tmp")},{"agents",Json::array()},{"entryCount",1}});
    };
    store.apply(welcome("/sessions/one","one"));
    store.apply(welcome("/sessions/two","two"));
    store.apply(eventFrom({{"t","snapshot-chunk"},{"sessionPath","/sessions/two"},{"entries",Json::array({entryJson("2","second")})},{"final",true}}));
    store.apply(eventFrom({{"t","snapshot-chunk"},{"sessionPath","/sessions/one"},{"entries",Json::array({entryJson("1","first")})},{"final",true}}));
    check(store.session("/sessions/one")->entries.front().id=="1","first session frame crossed sessions");
    check(store.session("/sessions/two")->entries.front().id=="2","second session frame crossed sessions");

    store.apply(eventFrom({{"t","session-tabs"},{"tabs",Json::array({
        {{"path","/sessions/one"},{"title","One"},{"cwd","/"},{"active",true},{"running",false},{"unread",0},{"draftDirty",false}},
        {{"path","/sessions/two"},{"title","Two"},{"cwd","/"},{"active",false},{"running",true},{"unread",4},{"draftDirty",true}}
    })}}));
    check(store.activeSessionPath()&&*store.activeSessionPath()=="/sessions/one","active tab projection failed");
    store.apply(eventFrom({{"t","entry"},{"sessionPath","/sessions/two"},{"entry",entryJson("3","new")}}));
    check(store.tabs()[1].unread==5,"inactive session activity did not increment unread");
    store.apply(eventFrom({{"t","entry"},{"sessionPath","/sessions/one"},{"entry",entryJson("4","active")}}));
    check(store.tabs()[0].unread==0,"active session activity changed unread");
}

class FakeTransport final : public ITransport {
public:
    void start() override { started=true; }
    void stop() override { started=false; }
    bool sendText(std::string_view text) override { if(!accept)return false;sent.emplace_back(text);return true; }
    std::vector<std::string> drainRaw() override { auto out=std::move(incoming);incoming.clear();return out; }
    bool connected() const noexcept override { return accept; }
    std::size_t droppedIncoming() const noexcept override { return 0; }
    bool started=false;
    bool accept=true;
    std::vector<std::string> sent;
    std::vector<std::string> incoming;
};

void testClientCorrelationErrorsAndTimeout() {
    DesktopStore store;
    FakeTransport transport;
    DesktopClient client(transport,store);
    bool success=false;
    const auto id=client.request("runtime.hello",{{"protocol",1}},[&](const ResponseFrame& response){success=response.result.has_value()&&!response.error;});
    transport.incoming.push_back(Json{{"t","response"},{"id",id},{"method","runtime.hello"},{"result",{{"protocol",1},{"product","chudcode"}}}}.dump());
    client.drain();
    check(success&&client.pendingCount()==0,"response correlation failed");

    bool receivedError=false;
    const auto errorId=client.request("run.abort",{{"sessionPath","s"}},[&](const ResponseFrame& response){receivedError=response.error&&response.error->code=="denied";});
    transport.incoming.push_back(Json{{"t","response"},{"id",errorId},{"method","run.abort"},{"error",{{"code","denied"},{"message","no"}}}}.dump());
    client.drain();
    check(receivedError,"response error was not correlated");

    transport.incoming.push_back(Json{{"t","response"},{"id",99999},{"method","runtime.hello"},{"result",{{"protocol",1},{"product","x"}}}}.dump());
    client.drain();
    check(!store.errors().empty()&&store.errors().back().code=="unexpected-response","unknown response id was not reported");

    bool timedOut=false;
    client.request("session.tabs",Json::object(),[&](const ResponseFrame& response){timedOut=response.error&&response.error->code=="timeout";},std::chrono::milliseconds(1));
    client.drain(DesktopClient::Clock::now()+std::chrono::seconds(1));
    check(timedOut&&client.pendingCount()==0,"request timeout failed");

    transport.accept=false;
    bool backpressured=false;
    client.request("session.tabs",Json::object(),[&](const ResponseFrame& response){backpressured=response.error&&response.error->code=="transport-backpressure";});
    check(backpressured&&client.pendingCount()==0,"transport backpressure did not fail request immediately");
}

void testReconnectAndBound() {
    check(WsTransport::reconnectDelaySeconds(0,1,30)==1,"reconnect minimum failed");
    check(WsTransport::reconnectDelaySeconds(4,1,30)==16,"reconnect exponential failed");
    check(WsTransport::reconnectDelaySeconds(20,1,30)==30,"reconnect maximum failed");
    BoundedRawFifo fifo(2);
    fifo.push("one");fifo.push("two");fifo.push("three");
    const auto values=fifo.drain();
    check(values==std::vector<std::string>({"two","three"}),"bounded FIFO ordering/eviction failed");
    check(fifo.dropped()==1,"bounded FIFO drop count failed");
    const char* args[]={"gui","--desktop-host","127.0.0.1:9000/ws","--desktop-token=secret"};
    const auto bootstrap=TransportBootstrap::fromProcess(4,args);
    check(bootstrap.url=="ws://127.0.0.1:9000/ws","host bootstrap did not form WebSocket URL");
    check(bootstrap.token=="secret","CLI bearer bootstrap failed");
    rejects([] { WsTransport transport({"ws://example.com/ws","secret"}); },
        "non-loopback transport target was accepted");
}

void testTerminalBytesAndWorkspaceResponses() {
    DesktopStore store;
    store.apply(eventFrom({{"t","terminal-data"},{"terminalId","term"},{"dataBase64","AAEC/w=="}}));
    const auto* terminal=store.terminal("term");
    check(terminal&&terminal->bytes==std::vector<std::uint8_t>({0,1,2,255}),"terminal bytes were not base64 exact");
    rejects([&] { store.apply(eventFrom({{"t","terminal-data"},{"terminalId","bad"},{"dataBase64","AB=="}})); },"non-canonical terminal base64 was accepted");

    store.applyResponse("workspace.recent",Json::object(),{{"projects",Json::array({{{"rootPath","/p"},{"displayName","P"},{"lastOpenedMs",9}}})}});
    check(store.recentProjects().size()==1&&store.recentProjects()[0].rootPath=="/p","recent project response was not stored");
    store.applyResponse("workspace.open",{{"rootPath","/p"}},{{"workspace",{{"id","w"},{"rootPath","/p"},{"displayName","P"}}}});
    check(store.workspace("w")&&store.workspace("w")->descriptor,"workspace open response was not stored");
    store.apply(eventFrom({{"t","document"},{"origin","external"},{"document",{
        {"id","d"},{"uri","file:///p/a.cpp"},{"language","cpp"},{"text","x"},
        {"stamp",{{"sha256","h"},{"size",1},{"mtimeNs",2},{"generation",3}}},{"dirty",false},{"conflict",false}
    }}}));
    check(store.documentByUri("file:///p/a.cpp")&&store.documentById("d"),"document event was not projected");
    store.apply(eventFrom({{"t","git"},{"workspaceId","w"},{"snapshot",{
        {"root","/p"},{"branch","main"},{"ahead",0},{"behind",0},{"files",Json::array()},{"commits",Json::array()}
    }}}));
    check(store.workspace("w")->git&&store.workspace("w")->git->branch=="main","git event was not projected");
    store.apply(eventFrom({{"t","diagnostics"},{"workspaceId","w"},{"diagnostics",Json::array({
        {{"uri","file:///p/a.cpp"},{"severity",2},{"message","warn"},{"startLine",0},{"startColumn",1},{"endLine",0},{"endColumn",2}}
    })}}));
    check(store.workspace("w")->diagnostics.size()==1,"diagnostics event was not projected");
    store.apply(eventFrom({{"t","graph"},{"workspaceId","w"},{"kind","code"},{"graph",{
        {"revision",1},{"nodes",Json::array()},{"edges",Json::array()}
    }}}));
    check(store.graph("w",GraphKind::Code)&&store.graph("w",GraphKind::Code)->revision==1,"graph event was not projected");
}

} // namespace

int main() {
    try {
        testCodecRoundTrips();
        testOrderedSessionsAndStoreProjection();
        testClientCorrelationErrorsAndTimeout();
        testReconnectAndBound();
        testTerminalBytesAndWorkspaceResponses();
        std::cout << "protocol tests passed\n";
        return 0;
    } catch(const std::exception& e) {
        std::cerr << "protocol test failure: " << e.what() << '\n';
        return 1;
    }
}
