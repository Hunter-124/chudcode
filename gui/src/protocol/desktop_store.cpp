#include "protocol/desktop_store.h"

#include <algorithm>
#include <array>
#include <type_traits>

#include "protocol/json_codec.h"

namespace chud {
namespace {

std::vector<std::uint8_t> decodeBase64(std::string_view input) {
    static constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (input.size() % 4 != 0) throw StoreError("terminal dataBase64 has invalid length");
    std::vector<std::uint8_t> output;
    output.reserve(input.size() / 4 * 3);
    for (std::size_t i = 0; i < input.size(); i += 4) {
        std::array<int, 4> value{};
        int padding = 0;
        for (int n = 0; n < 4; ++n) {
            const char c = input[i + static_cast<std::size_t>(n)];
            if (c == '=') {
                if (n < 2 || i + 4 != input.size()) throw StoreError("terminal dataBase64 has invalid padding");
                value[n] = 0;
                ++padding;
            } else {
                if (padding != 0) throw StoreError("terminal dataBase64 has data after padding");
                const auto pos = alphabet.find(c);
                if (pos == std::string_view::npos) throw StoreError("terminal dataBase64 has invalid character");
                value[n] = static_cast<int>(pos);
            }
        }
        if (padding > 2) throw StoreError("terminal dataBase64 has too much padding");
        const auto bits = static_cast<std::uint32_t>((value[0] << 18) | (value[1] << 12) | (value[2] << 6) | value[3]);
        output.push_back(static_cast<std::uint8_t>((bits >> 16) & 0xff));
        if (padding < 2) output.push_back(static_cast<std::uint8_t>((bits >> 8) & 0xff));
        if (padding < 1) output.push_back(static_cast<std::uint8_t>(bits & 0xff));
        if (padding == 1 && (value[2] & 0x03) != 0) throw StoreError("terminal dataBase64 has non-canonical padding");
        if (padding == 2 && (value[1] & 0x0f) != 0) throw StoreError("terminal dataBase64 has non-canonical padding");
    }
    return output;
}

template <typename T>
T get(const Json& j, std::string_view key) {
    try {
        const auto it = j.find(std::string(key));
        if (it == j.end()) throw StoreError("response missing field: " + std::string(key));
        return it->get<T>();
    } catch (const nlohmann::json::exception&) {
        throw StoreError("response field has invalid type: " + std::string(key));
    }
}

FileStamp parseStamp(const Json& j) {
    return {get<std::string>(j,"sha256"),get<std::int64_t>(j,"size"),get<std::int64_t>(j,"mtimeNs"),get<std::int64_t>(j,"generation")};
}
WorkspaceEntry parseEntry(const Json& j) {
    WorkspaceEntry e{get<std::string>(j,"uri"),get<std::string>(j,"name"),get<std::string>(j,"relativePath"),get<bool>(j,"directory"),get<bool>(j,"ignored"),std::nullopt};
    if (auto it=j.find("stamp");it!=j.end()&&!it->is_null()) e.stamp=parseStamp(*it);
    return e;
}
RecentProject parseRecent(const Json& j) { return {get<std::string>(j,"rootPath"),get<std::string>(j,"displayName"),get<std::int64_t>(j,"lastOpenedMs")}; }

} // namespace

const SessionSnapshot* DesktopStore::session(std::string_view path) const noexcept {
    const auto it=sessionSnapshots_.find(std::string(path)); return it==sessionSnapshots_.end()?nullptr:&it->second;
}
SessionSnapshot* DesktopStore::session(std::string_view path) noexcept {
    const auto it=sessionSnapshots_.find(std::string(path)); return it==sessionSnapshots_.end()?nullptr:&it->second;
}
const SessionSnapshot* DesktopStore::activeSession() const noexcept { return activeSessionPath_?session(*activeSessionPath_):nullptr; }
const WorkspaceSnapshot* DesktopStore::workspace(std::string_view id) const noexcept { const auto it=workspaces_.find(std::string(id));return it==workspaces_.end()?nullptr:&it->second; }
WorkspaceSnapshot* DesktopStore::workspace(std::string_view id) noexcept { const auto it=workspaces_.find(std::string(id));return it==workspaces_.end()?nullptr:&it->second; }
const DocumentSnapshot* DesktopStore::documentById(std::string_view id) const noexcept {const auto it=documentsById_.find(std::string(id));return it==documentsById_.end()?nullptr:&it->second;}
const DocumentSnapshot* DesktopStore::documentByUri(std::string_view uri) const noexcept {const auto it=documentIdsByUri_.find(std::string(uri));return it==documentIdsByUri_.end()?nullptr:documentById(it->second);}
const TerminalSnapshot* DesktopStore::terminal(std::string_view id) const noexcept {const auto it=terminals_.find(std::string(id));return it==terminals_.end()?nullptr:&it->second;}
const GraphSnapshot* DesktopStore::graph(std::string_view workspaceId, GraphKind kind) const noexcept {const auto* w=workspace(workspaceId);if(!w)return nullptr;const auto it=w->graphs.find(kind);return it==w->graphs.end()?nullptr:&it->second;}

void DesktopStore::markSessionActivity(const std::string& path) {
    if (activeSessionPath_ && *activeSessionPath_ == path) return;
    const auto it=std::find_if(tabs_.begin(),tabs_.end(),[&](const auto& tab){return tab.path==path;});
    if(it!=tabs_.end()) ++it->unread;
}

void DesktopStore::putDocument(DocumentSnapshot document) {
    const auto existing=documentIdsByUri_.find(document.uri);
    if(existing!=documentIdsByUri_.end()&&existing->second!=document.id)documentsById_.erase(existing->second);
    documentIdsByUri_[document.uri]=document.id;
    documentsById_[document.id]=std::move(document);
}

void DesktopStore::apply(const EventFrame& event) {
    std::visit([this](const auto& e) {
        using T=std::decay_t<decltype(e)>;
        if constexpr(std::is_same_v<T,WelcomeEvent>) {
            auto& s=sessionSnapshots_[e.sessionPath];s.header=e.header;s.state=e.state;s.agents=e.agents;s.expectedEntryCount=e.entryCount;s.entries.clear();s.snapshotComplete=false;s.latestAgentEvent.reset();s.uiRequest.reset();
        } else if constexpr(std::is_same_v<T,SnapshotChunkEvent>) {
            auto& s=sessionSnapshots_[e.sessionPath];s.entries.insert(s.entries.end(),e.entries.begin(),e.entries.end());s.snapshotComplete=e.final;
        } else if constexpr(std::is_same_v<T,EntryEvent>) {
            sessionSnapshots_[e.sessionPath].entries.push_back(e.entry);markSessionActivity(e.sessionPath);
        } else if constexpr(std::is_same_v<T,AgentEventFrame>) {
            sessionSnapshots_[e.sessionPath].latestAgentEvent=e.event;markSessionActivity(e.sessionPath);
        } else if constexpr(std::is_same_v<T,StateEvent>) sessionSnapshots_[e.sessionPath].state=e.state;
        else if constexpr(std::is_same_v<T,BusEvent>) sessionSnapshots_[e.sessionPath].busEvents.push_back(e);
        else if constexpr(std::is_same_v<T,AgentsEvent>) sessionSnapshots_[e.sessionPath].agents=e.agents;
        else if constexpr(std::is_same_v<T,UiRequestEvent>) sessionSnapshots_[e.sessionPath].uiRequest=e.request;
        else if constexpr(std::is_same_v<T,UiRequestEndEvent>) {auto& r=sessionSnapshots_[e.sessionPath].uiRequest;if(r&&r->reqId==e.reqId)r.reset();}
        else if constexpr(std::is_same_v<T,SessionsEvent>) sessions_=e.sessions;
        else if constexpr(std::is_same_v<T,SessionTabsEvent>) {
            tabs_=e.tabs;activeSessionPath_.reset();for(const auto& tab:tabs_)if(tab.active){activeSessionPath_=tab.path;break;}
        } else if constexpr(std::is_same_v<T,WorkspaceChangeEvent>) workspaces_[e.workspaceId].latestChanges=e.changes;
        else if constexpr(std::is_same_v<T,DocumentEvent>) putDocument(e.document);
        else if constexpr(std::is_same_v<T,GitEvent>) workspaces_[e.workspaceId].git=e.snapshot;
        else if constexpr(std::is_same_v<T,TerminalDataEvent>) {auto decoded=decodeBase64(e.dataBase64);auto& bytes=terminals_[e.terminalId].bytes;bytes.insert(bytes.end(),decoded.begin(),decoded.end());}
        else if constexpr(std::is_same_v<T,TerminalExitEvent>) {auto& t=terminals_[e.terminalId];t.exited=true;t.exitCode=e.exitCode;t.signal=e.signal;}
        else if constexpr(std::is_same_v<T,DiagnosticsEvent>) workspaces_[e.workspaceId].diagnostics=e.diagnostics;
        else if constexpr(std::is_same_v<T,GraphEvent>) workspaces_[e.workspaceId].graphs[e.kind]=e.graph;
        else if constexpr(std::is_same_v<T,ErrorEvent>) errors_.push_back(e);
        else if constexpr(std::is_same_v<T,UnknownEvent>) ++unknownEventCount_;
    },event.payload);
}

void DesktopStore::applyResponse(std::string_view method, const Json& params, const Json& result) {
    try {
        if(method=="workspace.recent") {
            const auto& xs=result.at("projects");if(!xs.is_array())throw StoreError("projects response is not an array");recentProjects_.clear();for(const auto& x:xs)recentProjects_.push_back(parseRecent(x));
        } else if(method=="workspace.open") {
            const auto& x=result.at("workspace");WorkspaceDescriptor d{get<std::string>(x,"id"),get<std::string>(x,"rootPath"),get<std::string>(x,"displayName")};workspaces_[d.id].descriptor=std::move(d);
        } else if(method=="workspace.list") {
            const auto id=get<std::string>(params,"workspaceId");const auto& xs=result.at("entries");if(!xs.is_array())throw StoreError("entries response is not an array");auto& entries=workspaces_[id].entries;entries.clear();for(const auto& x:xs)entries.push_back(parseEntry(x));
        } else if(method=="workspace.read") {
            const auto id=get<std::string>(params,"workspaceId");auto document=json_codec::parseDocumentSnapshot(result.at("document"));putDocument(document);auto& w=workspaces_[id];w.documentIdsByUri[document.uri]=document.id;w.documentsById[document.id]=std::move(document);
        } else if(method=="git.init"||method=="git.fetch"||method=="git.pull"||method=="git.push"||method=="git.branch.create"||method=="git.hunk"||method=="git.snapshot"||method=="git.stage"||method=="git.unstage"||method=="git.commit"||method=="git.checkout") {
            workspaces_[get<std::string>(params,"workspaceId")].git=json_codec::parseGitSnapshot(result.at("snapshot"));
        } else if(method=="graph.snapshot") {
            const auto id=get<std::string>(params,"workspaceId");const auto kind=get<std::string>(params,"kind");GraphKind k;if(kind=="code")k=GraphKind::Code;else if(kind=="git")k=GraphKind::Git;else if(kind=="agent")k=GraphKind::Agent;else throw StoreError("unknown graph kind");workspaces_[id].graphs[k]=json_codec::parseGraphSnapshot(result.at("graph"));
        } else if(method=="terminal.create") terminals_.try_emplace(get<std::string>(result,"terminalId"));
    } catch(const nlohmann::json::exception& e) {
        throw StoreError(std::string("malformed response for ")+std::string(method)+": "+e.what());
    }
}

} // namespace chud
