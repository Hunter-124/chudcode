#include "protocol/json_codec.h"

#include <initializer_list>
#include <type_traits>

namespace chud::json_codec {
namespace {

template <typename T>
T required(const Json& object, std::string_view key) {
    if (!object.is_object()) throw CodecError("expected object");
    const auto it = object.find(std::string(key));
    if (it == object.end()) throw CodecError("missing required field: " + std::string(key));
    try { return it->get<T>(); }
    catch (const Json::exception&) { throw CodecError("invalid type for field: " + std::string(key)); }
}

template <typename T>
std::optional<T> optional(const Json& object, std::string_view key) {
    const auto it = object.find(std::string(key));
    if (it == object.end() || it->is_null()) return std::nullopt;
    try { return it->get<T>(); }
    catch (const Json::exception&) { throw CodecError("invalid type for field: " + std::string(key)); }
}

template <typename T>
std::optional<T> requiredNullable(const Json& object, std::string_view key) {
    const auto it = object.find(std::string(key));
    if (it == object.end()) throw CodecError("missing required field: " + std::string(key));
    if (it->is_null()) return std::nullopt;
    try { return it->get<T>(); }
    catch (const Json::exception&) { throw CodecError("invalid type for field: " + std::string(key)); }
}

const Json& requiredObject(const Json& object, std::string_view key) {
    const auto it = object.find(std::string(key));
    if (it == object.end() || !it->is_object()) throw CodecError("missing or invalid object: " + std::string(key));
    return *it;
}
const Json& requiredArray(const Json& object, std::string_view key) {
    const auto it = object.find(std::string(key));
    if (it == object.end() || !it->is_array()) throw CodecError("missing or invalid array: " + std::string(key));
    return *it;
}

void putOptional(Json& object, std::string_view key, const auto& value) {
    if (value) object[std::string(key)] = *value;
}

DesktopSessionInfo::Status sessionStatus(std::string_view value) {
    if (value == "completed") return DesktopSessionInfo::Status::Completed;
    if (value == "failed") return DesktopSessionInfo::Status::Failed;
    if (value == "interrupted") return DesktopSessionInfo::Status::Interrupted;
    if (value == "active") return DesktopSessionInfo::Status::Active;
    throw CodecError("unknown session status");
}
std::string_view text(DesktopSessionInfo::Status value) {
    switch (value) { case DesktopSessionInfo::Status::Completed: return "completed"; case DesktopSessionInfo::Status::Failed: return "failed"; case DesktopSessionInfo::Status::Interrupted: return "interrupted"; case DesktopSessionInfo::Status::Active: return "active"; }
    throw CodecError("invalid session status");
}

ChangeOrigin changeOrigin(std::string_view value) {
    if (value == "external") return ChangeOrigin::External;
    if (value == "agent") return ChangeOrigin::Agent;
    if (value == "user") return ChangeOrigin::User;
    throw CodecError("unknown change origin");
}
std::string_view text(ChangeOrigin value) {
    switch (value) { case ChangeOrigin::External: return "external"; case ChangeOrigin::Agent: return "agent"; case ChangeOrigin::User: return "user"; }
    throw CodecError("invalid change origin");
}
FileChangeKind fileChangeKind(std::string_view value) {
    if (value == "created") return FileChangeKind::Created;
    if (value == "modified") return FileChangeKind::Modified;
    if (value == "deleted") return FileChangeKind::Deleted;
    if (value == "renamed") return FileChangeKind::Renamed;
    if (value == "rescan-required") return FileChangeKind::RescanRequired;
    throw CodecError("unknown file change kind");
}
std::string_view text(FileChangeKind value) {
    switch (value) { case FileChangeKind::Created: return "created"; case FileChangeKind::Modified: return "modified"; case FileChangeKind::Deleted: return "deleted"; case FileChangeKind::Renamed: return "renamed"; case FileChangeKind::RescanRequired: return "rescan-required"; }
    throw CodecError("invalid file change kind");
}
GraphState graphState(std::string_view value) {
    if (value == "entering") return GraphState::Entering;
    if (value == "stable") return GraphState::Stable;
    if (value == "changing") return GraphState::Changing;
    if (value == "leaving") return GraphState::Leaving;
    throw CodecError("unknown graph state");
}
std::string_view text(GraphState value) {
    switch (value) { case GraphState::Entering: return "entering"; case GraphState::Stable: return "stable"; case GraphState::Changing: return "changing"; case GraphState::Leaving: return "leaving"; }
    throw CodecError("invalid graph state");
}
GraphKind graphKind(std::string_view value) {
    if (value == "code") return GraphKind::Code;
    if (value == "git") return GraphKind::Git;
    if (value == "agent") return GraphKind::Agent;
    throw CodecError("unknown graph kind");
}
std::string_view text(GraphKind value) {
    switch (value) { case GraphKind::Code: return "code"; case GraphKind::Git: return "git"; case GraphKind::Agent: return "agent"; }
    throw CodecError("invalid graph kind");
}

FileStamp parseStamp(const Json& j) {
    return {required<std::string>(j,"sha256"), required<std::int64_t>(j,"size"), required<std::int64_t>(j,"mtimeNs"), required<std::int64_t>(j,"generation")};
}
Json encodeStamp(const FileStamp& v) { return {{"sha256",v.sha256},{"size",v.size},{"mtimeNs",v.mtimeNs},{"generation",v.generation}}; }

DesktopSessionInfo parseSessionInfo(const Json& j) {
    DesktopSessionInfo v{required<std::string>(j,"id"), required<std::string>(j,"path"), required<std::string>(j,"cwd"), optional<std::string>(j,"title"), optional<std::string>(j,"parentSessionPath"), required<std::int64_t>(j,"createdMs"), required<std::int64_t>(j,"modifiedMs"), required<std::int64_t>(j,"messageCount"), required<std::int64_t>(j,"size"), std::nullopt, optional<bool>(j,"pinned")};
    if (auto s=optional<std::string>(j,"status")) v.status=sessionStatus(*s);
    return v;
}
Json encodeSessionInfo(const DesktopSessionInfo& v) {
    Json j={{"id",v.id},{"path",v.path},{"cwd",v.cwd},{"createdMs",v.createdMs},{"modifiedMs",v.modifiedMs},{"messageCount",v.messageCount},{"size",v.size}};
    putOptional(j,"title",v.title); putOptional(j,"parentSessionPath",v.parentSessionPath); putOptional(j,"pinned",v.pinned); if(v.status) j["status"]=text(*v.status); return j;
}
DesktopSessionTab parseTab(const Json& j) { return {required<std::string>(j,"path"),required<std::string>(j,"title"),required<std::string>(j,"cwd"),required<bool>(j,"active"),required<bool>(j,"running"),required<std::int64_t>(j,"unread"),required<bool>(j,"draftDirty")}; }
Json encodeTab(const DesktopSessionTab& v) { return {{"path",v.path},{"title",v.title},{"cwd",v.cwd},{"active",v.active},{"running",v.running},{"unread",v.unread},{"draftDirty",v.draftDirty}}; }

WorkspaceEntry parseWorkspaceEntry(const Json& j) {
    WorkspaceEntry v{required<std::string>(j,"uri"),required<std::string>(j,"name"),required<std::string>(j,"relativePath"),required<bool>(j,"directory"),required<bool>(j,"ignored"),std::nullopt};
    if (auto it=j.find("stamp"); it!=j.end()&&!it->is_null()) v.stamp=parseStamp(*it); return v;
}
FileChange parseFileChange(const Json& j) {
    FileChange v{fileChangeKind(required<std::string>(j,"kind")),required<std::string>(j,"uri"),optional<std::string>(j,"oldUri"),std::nullopt,changeOrigin(required<std::string>(j,"origin"))};
    if (auto it=j.find("stamp"); it!=j.end()&&!it->is_null()) v.stamp=parseStamp(*it); return v;
}
Json encodeFileChange(const FileChange& v) { Json j={{"kind",text(v.kind)},{"uri",v.uri},{"origin",text(v.origin)}}; putOptional(j,"oldUri",v.oldUri); if(v.stamp)j["stamp"]=encodeStamp(*v.stamp); return j; }

GitFileState parseGitFile(const Json& j) { return {required<std::string>(j,"path"),required<std::string>(j,"staged"),required<std::string>(j,"unstaged"),required<bool>(j,"untracked")}; }
GitCommit parseCommit(const Json& j) { return {required<std::string>(j,"hash"),required<std::vector<std::string>>(j,"parents"),required<std::string>(j,"author"),required<std::int64_t>(j,"timestampMs"),required<std::string>(j,"subject"),required<std::vector<std::string>>(j,"refs")}; }
Json encodeCommit(const GitCommit& v) { return {{"hash",v.hash},{"parents",v.parents},{"author",v.author},{"timestampMs",v.timestampMs},{"subject",v.subject},{"refs",v.refs}}; }

LspDiagnostic parseDiagnostic(const Json& j) {
    auto severity=required<int>(j,"severity"); if(severity<1||severity>4) throw CodecError("diagnostic severity out of range");
    return {required<std::string>(j,"uri"),static_cast<std::uint8_t>(severity),required<std::string>(j,"message"),optional<std::string>(j,"source"),required<std::int64_t>(j,"startLine"),required<std::int64_t>(j,"startColumn"),required<std::int64_t>(j,"endLine"),required<std::int64_t>(j,"endColumn")};
}
Json encodeDiagnostic(const LspDiagnostic& v) { Json j={{"uri",v.uri},{"severity",v.severity},{"message",v.message},{"startLine",v.startLine},{"startColumn",v.startColumn},{"endLine",v.endLine},{"endColumn",v.endColumn}}; putOptional(j,"source",v.source); return j; }

SessionHeader parseHeader(const Json& j) {
    if(required<std::string>(j,"type")!="session") throw CodecError("invalid session header type");
    return {required<std::string>(j,"id"),optional<std::string>(j,"title"),required<std::string>(j,"timestamp"),required<std::string>(j,"cwd")};
}
Json encodeHeader(const SessionHeader& v) { Json j={{"type","session"},{"id",v.id},{"timestamp",v.timestamp},{"cwd",v.cwd}}; putOptional(j,"title",v.title); return j; }

void validateImages(const Json& images) {
    if(!images.is_array())throw CodecError("images must be an array");
    for(const auto& image:images) {
        if(required<std::string>(image,"type")!="image")throw CodecError("image content has invalid type");
        required<std::string>(image,"data");required<std::string>(image,"mimeType");
    }
}

void validateContentArray(const Json& content, bool assistant) {
    if(!content.is_array())throw CodecError("message content must be an array");
    for(const auto& block:content) {
        const auto type=required<std::string>(block,"type");
        if(type=="text")required<std::string>(block,"text");
        else if(type=="image"){required<std::string>(block,"data");required<std::string>(block,"mimeType");}
        else if(assistant&&type=="thinking")required<std::string>(block,"thinking");
        else if(assistant&&type=="redactedThinking")required<std::string>(block,"data");
        else if(assistant&&type=="toolCall"){required<std::string>(block,"id");required<std::string>(block,"name");requiredObject(block,"arguments");(void)optional<std::string>(block,"intent");}
        // Future additive content block tags remain in the lossless payload.
    }
}

void validateTextOrContent(const Json& message) {
    const auto it=message.find("content");
    if(it==message.end())throw CodecError("message missing content");
    if(!it->is_string())validateContentArray(*it,false);
}

void validateMessage(const Json& message) {
    const auto role = required<std::string>(message, "role");
    if (role == "user" || role == "developer") {
        validateTextOrContent(message);
        required<std::int64_t>(message, "timestamp");
    } else if (role == "assistant") {
        validateContentArray(requiredArray(message, "content"),true);
        required<std::string>(message, "model");
        const auto stopReason=required<std::string>(message,"stopReason");
        if(stopReason!="stop"&&stopReason!="length"&&stopReason!="toolUse"&&stopReason!="error"&&stopReason!="aborted")throw CodecError("unknown assistant stopReason");
        required<std::int64_t>(message, "timestamp");
        const auto& usage = requiredObject(message, "usage");
        required<std::int64_t>(usage, "input");
        required<std::int64_t>(usage, "output");
        required<std::int64_t>(usage, "cacheRead");
        required<std::int64_t>(usage, "cacheWrite");
        required<std::int64_t>(usage, "totalTokens");
        required<double>(requiredObject(usage, "cost"), "total");
    } else if (role == "toolResult") {
        required<std::string>(message, "toolCallId");
        required<std::string>(message, "toolName");
        validateContentArray(requiredArray(message, "content"),false);
        required<bool>(message, "isError");
        required<std::int64_t>(message, "timestamp");
    } else {
        throw CodecError("unsupported wire message role: " + role);
    }
}

SessionEntry parseEntry(const Json& j) {
    const auto tag=required<std::string>(j,"type");
    SessionEntryKind kind;
    if(tag=="message") {
        kind=SessionEntryKind::Message;
        validateMessage(requiredObject(j,"message"));
    } else if(tag=="custom_message") {
        kind=SessionEntryKind::CustomMessage;
        required<std::string>(j,"customType");
        validateTextOrContent(j);
        required<bool>(j,"display");
    } else if(tag=="compaction") {
        kind=SessionEntryKind::Compaction;
        required<std::string>(j,"summary");
        required<std::string>(j,"firstKeptEntryId");
        required<std::int64_t>(j,"tokensBefore");
    } else if(tag=="branch_summary") {
        kind=SessionEntryKind::BranchSummary;
        required<std::string>(j,"fromId");
        required<std::string>(j,"summary");
    } else if(tag=="model_change") {
        kind=SessionEntryKind::ModelChange;
        required<std::string>(j,"model");
    } else if(tag=="thinking_level_change") {
        kind=SessionEntryKind::ThinkingLevelChange;
    } else {
        kind=SessionEntryKind::Unknown;
    }
    auto parent=optional<std::string>(j,"parentId");
    if(!j.contains("parentId")) throw CodecError("missing required field: parentId");
    return {kind,required<std::string>(j,"id"),parent,required<std::string>(j,"timestamp"),j};
}
Json encodeEntry(const SessionEntry& v) { return v.payload; }

AgentSnapshot parseAgent(const Json& j) {
    AgentSnapshot::Kind kind; const auto k=required<std::string>(j,"kind"); if(k=="main")kind=AgentSnapshot::Kind::Main; else if(k=="sub")kind=AgentSnapshot::Kind::Sub; else throw CodecError("unknown agent kind");
    AgentSnapshot::Status status; const auto s=required<std::string>(j,"status"); if(s=="running")status=AgentSnapshot::Status::Running; else if(s=="idle")status=AgentSnapshot::Status::Idle; else if(s=="parked")status=AgentSnapshot::Status::Parked; else if(s=="aborted")status=AgentSnapshot::Status::Aborted; else throw CodecError("unknown agent status");
    return {required<std::string>(j,"id"),required<std::string>(j,"displayName"),kind,optional<std::string>(j,"parentId"),status,required<bool>(j,"hasSessionFile"),required<std::int64_t>(j,"createdAt"),required<std::int64_t>(j,"lastActivity")};
}
Json encodeAgent(const AgentSnapshot& v) { Json j={{"id",v.id},{"displayName",v.displayName},{"kind",v.kind==AgentSnapshot::Kind::Main?"main":"sub"},{"status",v.status==AgentSnapshot::Status::Running?"running":v.status==AgentSnapshot::Status::Idle?"idle":v.status==AgentSnapshot::Status::Parked?"parked":"aborted"},{"hasSessionFile",v.hasSessionFile},{"createdAt",v.createdAt},{"lastActivity",v.lastActivity}}; putOptional(j,"parentId",v.parentId); return j; }

AgentEvent parseAgentEvent(const Json& j) {
    const auto type=required<std::string>(j,"type");
    if(type=="message_start"||type=="message_update"||type=="message_end") validateMessage(requiredObject(j,"message"));
    else if(type=="tool_execution_start") { required<std::string>(j,"toolCallId"); required<std::string>(j,"toolName"); if(!j.contains("args"))throw CodecError("missing required field: args"); (void)optional<std::string>(j,"intent"); }
    else if(type=="tool_execution_update") { required<std::string>(j,"toolCallId"); required<std::string>(j,"toolName"); if(!j.contains("args")||!j.contains("partialResult"))throw CodecError("missing tool update payload"); }
    else if(type=="tool_execution_end") { required<std::string>(j,"toolCallId"); required<std::string>(j,"toolName"); if(!j.contains("result"))throw CodecError("missing required field: result"); (void)optional<bool>(j,"isError"); }
    else if(type=="notice") { const auto level=required<std::string>(j,"level");if(level!="info"&&level!="warning"&&level!="error")throw CodecError("unknown notice level");required<std::string>(j,"message");(void)optional<std::string>(j,"source"); }
    else if(type=="auto_compaction_start") { required<std::string>(j,"reason"); required<std::string>(j,"action"); }
    else if(type=="auto_compaction_end") { required<bool>(j,"aborted"); required<bool>(j,"willRetry");(void)optional<std::string>(j,"errorMessage");(void)optional<bool>(j,"skipped"); }
    else if(type=="auto_retry_start") { required<std::int64_t>(j,"attempt"); required<std::int64_t>(j,"maxAttempts"); required<std::int64_t>(j,"delayMs"); required<std::string>(j,"errorMessage"); }
    else if(type=="auto_retry_end") { required<bool>(j,"success"); required<std::int64_t>(j,"attempt");(void)optional<std::string>(j,"finalError"); }
    else if(type=="thinking_level_changed"){(void)optional<std::string>(j,"thinkingLevel");}
    // Unknown additive agent-event tags remain lossless in AgentEvent::payload.
    return {type,j};
}

UiRequest parseUiRequest(const Json& j) {
    UiRequest r{required<std::int64_t>(j,"reqId"),required<std::string>(j,"kind"),required<std::string>(j,"title"),j};
    if(r.kind=="select") {
        for(const auto& option:requiredArray(j,"options")) {
            if(option.is_string())continue;
            required<std::string>(option,"label");(void)optional<std::string>(option,"description");
        }
        (void)optional<std::int64_t>(j,"initialIndex");
        if(auto marker=optional<std::string>(j,"selectionMarker");marker&&*marker!="radio"&&*marker!="checkbox")throw CodecError("unknown selection marker");
        if(auto it=j.find("checkedIndices");it!=j.end())for(const auto& index:requiredArray(j,"checkedIndices"))if(!index.is_number_integer())throw CodecError("invalid checked index");
        (void)optional<std::int64_t>(j,"markableCount");(void)optional<std::string>(j,"helpText");
    } else if(r.kind=="editor") {
        (void)optional<std::string>(j,"prefill");
    }
    return r;
}


template <typename T, typename F>
std::vector<T> parseVector(const Json& array, F&& parser) { if(!array.is_array())throw CodecError("expected array"); std::vector<T> out; out.reserve(array.size()); for(const auto& x:array)out.push_back(parser(x)); return out; }

} // namespace
namespace {
template <typename T>
void checkOptional(const Json& j, std::string_view key) {
    if(j.contains(std::string(key))&&!j.at(std::string(key)).is_null()) (void)required<T>(j,key);
}

void requireStringArray(const Json& j, std::string_view key) {
    for(const auto& value:requiredArray(j,key)) {
        if(!value.is_string())throw CodecError("invalid string array field: "+std::string(key));
    }
}

void requireOneOf(const Json& j, std::string_view key, std::initializer_list<std::string_view> values) {
    const auto value=required<std::string>(j,key);
    for(const auto candidate:values)if(value==candidate)return;
    throw CodecError("unknown value for field: "+std::string(key));
}

void validateRequestParams(std::string_view method, const Json& p) {
    if(!p.is_object())throw CodecError("request params must be an object");
    auto str=[&](std::string_view key){(void)required<std::string>(p,key);};
    auto integer=[&](std::string_view key){(void)required<std::int64_t>(p,key);};
    auto boolean=[&](std::string_view key){(void)required<bool>(p,key);};
    auto workspace=[&]{str("workspaceId");};
    auto terminal=[&]{str("terminalId");};
    if(method=="runtime.hello") integer("protocol");
    else if(method=="prompt.send"){str("sessionPath");str("text");if(p.contains("images"))validateImages(requiredArray(p,"images"));}
    else if(method=="run.abort"){str("sessionPath");}
    else if(method=="ui.respond"){str("sessionPath");integer("reqId");checkOptional<std::string>(p,"value");}
    else if(method=="agent.command"){str("sessionPath");requireOneOf(p,"cmd",{"chat","kill","revive"});str("agentId");checkOptional<std::string>(p,"text");}
    else if(method=="agent.transcript"){str("sessionPath");str("agentId");integer("fromByte");}
    else if(method=="session.list"){checkOptional<std::string>(p,"cwd");}
    else if(method=="session.select"||method=="session.delete"||method=="session.activate"){str("path");}
    else if(method=="session.new"){str("cwd");}
    else if(method=="session.fork"){str("path");checkOptional<std::string>(p,"entryId");}
    else if(method=="session.rename"){str("path");str("title");}
    else if(method=="session.pin"){str("path");boolean("pinned");}
    else if(method=="session.tab.close"){str("path");checkOptional<bool>(p,"force");}
    else if(method=="session.tab.draft"){str("path");boolean("dirty");}
    else if(method=="workspace.pick"){checkOptional<std::string>(p,"initialPath");}
    else if(method=="workspace.open"){str("rootPath");}
    else if(method=="workspace.list"){workspace();checkOptional<std::string>(p,"uri");}
    else if(method=="workspace.read"||method=="workspace.stat"||method=="workspace.reveal"){workspace();str("uri");}
    else if(method=="workspace.write"){workspace();str("uri");str("text");str("expectedSha256");}
    else if(method=="workspace.create"){workspace();str("uri");checkOptional<bool>(p,"directory");}
    else if(method=="workspace.rename"){workspace();str("from");str("to");}
    else if(method=="workspace.copy"){workspace();str("from");str("to");checkOptional<bool>(p,"recursive");}
    else if(method=="workspace.remove"){workspace();str("uri");requireOneOf(p,"mode",{"trash","permanent"});}
    else if(method=="workspace.search"){workspace();const auto&q=requiredObject(p,"query");required<std::string>(q,"text");requireOneOf(q,"kind",{"files","content","symbols"});checkOptional<std::int64_t>(q,"maxResults");checkOptional<bool>(q,"includeIgnored");}
    else if(method=="git.init"||method=="git.branches"||method=="git.remotes"||method=="git.snapshot"){workspace();}
    else if(method=="git.fetch"){workspace();checkOptional<std::string>(p,"remote");}
    else if(method=="git.pull"){workspace();checkOptional<std::string>(p,"remote");checkOptional<std::string>(p,"branch");}
    else if(method=="git.push"){workspace();checkOptional<std::string>(p,"remote");checkOptional<std::string>(p,"branch");checkOptional<bool>(p,"setUpstream");}
    else if(method=="git.branch.create"){workspace();str("name");checkOptional<std::string>(p,"startPoint");checkOptional<bool>(p,"checkout");}
    else if(method=="git.hunk"){workspace();str("path");str("hunkId");requireOneOf(p,"action",{"stage","unstage","revert"});}
    else if(method=="git.diff"){workspace();checkOptional<std::string>(p,"path");checkOptional<bool>(p,"staged");}
    else if(method=="git.stage"||method=="git.unstage"){workspace();requireStringArray(p,"paths");}
    else if(method=="git.commit"){workspace();str("message");}
    else if(method=="git.checkout"){workspace();str("ref");}
    else if(method=="terminal.create"){workspace();integer("cols");integer("rows");}
    else if(method=="terminal.write"){terminal();str("data");}
    else if(method=="terminal.resize"){terminal();integer("cols");integer("rows");}
    else if(method=="terminal.close"){terminal();}
    else if(method=="lsp.request"){workspace();str("method");checkOptional<std::string>(p,"uri");checkOptional<std::string>(p,"query");checkOptional<std::string>(p,"newName");checkOptional<bool>(p,"includeDeclaration");}
    else if(method=="graph.snapshot"){workspace();requireOneOf(p,"kind",{"code","git","agent"});}
    else if(method!="session.tabs"&&method!="workspace.recent")throw CodecError("unsupported request method: "+std::string(method));
}

void validateResponseResult(std::string_view method, const Json& r) {
    if(!r.is_object())throw CodecError("response result must be an object");
    auto boolean=[&](std::string_view key){(void)required<bool>(r,key);};
    auto string=[&](std::string_view key){(void)required<std::string>(r,key);};
    auto sessionArray=[&](std::string_view key){for(const auto& x:requiredArray(r,key))(void)parseSessionInfo(x);};
    auto tabArray=[&]{for(const auto& x:requiredArray(r,"tabs"))(void)parseTab(x);};
    auto snapshot=[&]{(void)parseGitSnapshot(requiredObject(r,"snapshot"));};
    if(method=="runtime.hello"){(void)required<int>(r,"protocol");string("product");}
    else if(method=="prompt.send"){if(required<bool>(r,"accepted")!=true)throw CodecError("prompt.send accepted must be true");}
    else if(method=="run.abort"||method=="ui.respond"||method=="terminal.write"){boolean("accepted");}
    else if(method=="agent.command"){boolean("accepted");checkOptional<std::string>(r,"message");}
    else if(method=="agent.transcript"){string("text");(void)required<std::int64_t>(r,"newSize");checkOptional<std::string>(r,"error");}
    else if(method=="session.list")sessionArray("sessions");
    else if(method=="session.select"){(void)parseHeader(requiredObject(r,"header"));for(const auto&x:requiredArray(r,"entries"))(void)parseEntry(x);}
    else if(method=="session.new"||method=="session.rename"||method=="session.pin"){(void)parseSessionInfo(requiredObject(r,"session"));}
    else if(method=="session.fork"){(void)parseSessionInfo(requiredObject(r,"session"));checkOptional<std::string>(r,"selectedText");if(r.contains("selectedImages"))validateImages(requiredArray(r,"selectedImages"));checkOptional<bool>(r,"cancelled");}
    else if(method=="session.delete"){boolean("deleted");}
    else if(method=="session.tabs"||method=="session.activate"||method=="session.tab.draft")tabArray();
    else if(method=="session.tab.close"){boolean("closed");tabArray();checkOptional<std::string>(r,"blockedReason");}
    else if(method=="workspace.recent"){for(const auto&x:requiredArray(r,"projects")){required<std::string>(x,"rootPath");required<std::string>(x,"displayName");required<std::int64_t>(x,"lastOpenedMs");}}
    else if(method=="workspace.pick"){boolean("cancelled");checkOptional<std::string>(r,"rootPath");}
    else if(method=="workspace.open"){const auto&w=requiredObject(r,"workspace");required<std::string>(w,"id");required<std::string>(w,"rootPath");required<std::string>(w,"displayName");}
    else if(method=="workspace.list"){for(const auto&x:requiredArray(r,"entries"))(void)parseWorkspaceEntry(x);}
    else if(method=="workspace.read"){(void)parseDocumentSnapshot(requiredObject(r,"document"));}
    else if(method=="workspace.write"){(void)parseStamp(requiredObject(r,"stamp"));}
    else if(method=="workspace.stat"||method=="workspace.create"||method=="workspace.rename"||method=="workspace.copy"){(void)parseWorkspaceEntry(requiredObject(r,"entry"));}
    else if(method=="workspace.remove"){boolean("removed");}
    else if(method=="workspace.reveal"){boolean("revealed");}
    else if(method=="workspace.search"){for(const auto&x:requiredArray(r,"results")){required<std::string>(x,"uri");required<std::string>(x,"preview");checkOptional<std::int64_t>(x,"line");checkOptional<std::int64_t>(x,"column");checkOptional<double>(x,"score");}}
    else if(method=="git.branches"){for(const auto&x:requiredArray(r,"branches")){required<std::string>(x,"name");required<bool>(x,"current");required<bool>(x,"remote");}}
    else if(method=="git.remotes"){for(const auto&x:requiredArray(r,"remotes")){required<std::string>(x,"name");required<std::string>(x,"fetchUrl");required<std::string>(x,"pushUrl");}}
    else if(method=="git.diff"){string("unified");}
    else if(method=="git.commit"){(void)parseCommit(requiredObject(r,"commit"));snapshot();}
    else if(method=="git.init"||method=="git.fetch"||method=="git.pull"||method=="git.push"||method=="git.branch.create"||method=="git.hunk"||method=="git.snapshot"||method=="git.stage"||method=="git.unstage"||method=="git.checkout")snapshot();
    else if(method=="terminal.create")string("terminalId");
    else if(method=="terminal.resize"||method=="terminal.close"){}
    else if(method=="lsp.request"){if(!r.contains("value"))throw CodecError("lsp.request result missing value");}
    else if(method=="graph.snapshot"){(void)parseGraphSnapshot(requiredObject(r,"graph"));}
    else throw CodecError("unsupported response method: "+std::string(method));
}
} // namespace

const std::vector<std::string_view>& supportedMethods() noexcept {
    static const std::vector<std::string_view> names={"runtime.hello","prompt.send","run.abort","ui.respond","agent.command","agent.transcript","session.list","session.select","session.new","session.fork","session.rename","session.delete","session.pin","session.tabs","session.activate","session.tab.close","session.tab.draft","workspace.recent","workspace.pick","workspace.open","workspace.list","workspace.read","workspace.write","workspace.stat","workspace.create","workspace.rename","workspace.copy","workspace.remove","workspace.reveal","workspace.search","git.init","git.branches","git.remotes","git.fetch","git.pull","git.push","git.branch.create","git.hunk","git.snapshot","git.diff","git.stage","git.unstage","git.commit","git.checkout","terminal.create","terminal.write","terminal.resize","terminal.close","lsp.request","graph.snapshot"};
    return names;
}
bool isSupportedMethod(std::string_view method) noexcept { for(auto v:supportedMethods())if(v==method)return true; return false; }

DocumentSnapshot parseDocumentSnapshot(const Json& j) { return {required<std::string>(j,"id"),required<std::string>(j,"uri"),required<std::string>(j,"language"),required<std::string>(j,"text"),parseStamp(requiredObject(j,"stamp")),required<bool>(j,"dirty"),required<bool>(j,"conflict")}; }
Json encodeDocumentSnapshot(const DocumentSnapshot& v) { return {{"id",v.id},{"uri",v.uri},{"language",v.language},{"text",v.text},{"stamp",encodeStamp(v.stamp)},{"dirty",v.dirty},{"conflict",v.conflict}}; }

GitSnapshot parseGitSnapshot(const Json& j) { GitSnapshot v{required<std::string>(j,"root"),required<std::string>(j,"branch"),optional<std::string>(j,"upstream"),required<std::int64_t>(j,"ahead"),required<std::int64_t>(j,"behind"),{}, {}}; v.files=parseVector<GitFileState>(requiredArray(j,"files"),parseGitFile); v.commits=parseVector<GitCommit>(requiredArray(j,"commits"),parseCommit); return v; }
Json encodeGitSnapshot(const GitSnapshot& v) { Json files=Json::array(); for(auto& x:v.files)files.push_back({{"path",x.path},{"staged",x.staged},{"unstaged",x.unstaged},{"untracked",x.untracked}}); Json commits=Json::array();for(auto&x:v.commits)commits.push_back(encodeCommit(x)); Json j={{"root",v.root},{"branch",v.branch},{"ahead",v.ahead},{"behind",v.behind},{"files",files},{"commits",commits}};putOptional(j,"upstream",v.upstream);return j; }

GraphSnapshot parseGraphSnapshot(const Json& j) {
    GraphSnapshot v{required<std::int64_t>(j,"revision"),{}, {}};
    for(const auto& n:requiredArray(j,"nodes")) { GraphNode x{required<std::string>(n,"id"),required<std::string>(n,"label"),required<std::string>(n,"kind"),optional<std::string>(n,"group"),std::nullopt,{}}; if(auto s=optional<std::string>(n,"state"))x.state=graphState(*s); if(auto m=n.find("meta");m!=n.end()){if(!m->is_object())throw CodecError("invalid graph meta");for(auto&[key,val]:m->items()){if(val.is_null())x.meta[key]=nullptr;else if(val.is_string())x.meta[key]=val.get<std::string>();else if(val.is_boolean())x.meta[key]=val.get<bool>();else if(val.is_number())x.meta[key]=val.get<double>();else throw CodecError("graph meta value must be scalar");}} v.nodes.push_back(std::move(x)); }
    for(const auto& e:requiredArray(j,"edges")) { GraphEdge x{required<std::string>(e,"id"),required<std::string>(e,"source"),required<std::string>(e,"target"),required<std::string>(e,"kind"),std::nullopt};if(auto s=optional<std::string>(e,"state"))x.state=graphState(*s);v.edges.push_back(std::move(x)); }
    return v;
}
Json encodeGraphSnapshot(const GraphSnapshot& v) { Json nodes=Json::array();for(auto&x:v.nodes){Json n={{"id",x.id},{"label",x.label},{"kind",x.kind}};putOptional(n,"group",x.group);if(x.state)n["state"]=text(*x.state);if(!x.meta.empty()){Json m=Json::object();for(auto&[k,val]:x.meta)std::visit([&](auto&& z){m[k]=z;},val);n["meta"]=std::move(m);}nodes.push_back(std::move(n));}Json edges=Json::array();for(auto&x:v.edges){Json e={{"id",x.id},{"source",x.source},{"target",x.target},{"kind",x.kind}};if(x.state)e["state"]=text(*x.state);edges.push_back(std::move(e));}return {{"revision",v.revision},{"nodes",nodes},{"edges",edges}}; }

SessionState parseSessionState(const Json& j) {
    SessionState v{required<bool>(j,"isStreaming"),required<std::int64_t>(j,"queuedMessageCount"),optional<std::string>(j,"sessionName"),required<std::string>(j,"cwd"),std::nullopt,optional<std::string>(j,"thinkingLevel"),std::nullopt,{},optional<bool>(j,"isAborting")};
    if(auto it=j.find("model");it!=j.end()&&!it->is_null())v.model=WireModel{required<std::string>(*it,"id"),required<std::string>(*it,"name"),required<std::string>(*it,"provider"),requiredNullable<std::int64_t>(*it,"contextWindow")};
    if(auto it=j.find("contextUsage");it!=j.end()&&!it->is_null())v.contextUsage=ContextUsage{requiredNullable<std::int64_t>(*it,"tokens"),requiredNullable<std::int64_t>(*it,"contextWindow"),requiredNullable<double>(*it,"percent")};
    for(const auto&p:requiredArray(j,"participants")){Participant::Role role;auto r=required<std::string>(p,"role");if(r=="host")role=Participant::Role::Host;else if(r=="guest")role=Participant::Role::Guest;else throw CodecError("unknown participant role");v.participants.push_back({required<std::string>(p,"name"),role,optional<bool>(p,"readOnly")});}return v;
}
Json encodeSessionState(const SessionState& v) { Json j={{"isStreaming",v.isStreaming},{"queuedMessageCount",v.queuedMessageCount},{"cwd",v.cwd}};putOptional(j,"sessionName",v.sessionName);putOptional(j,"thinkingLevel",v.thinkingLevel);putOptional(j,"isAborting",v.isAborting);if(v.model){Json m={{"id",v.model->id},{"name",v.model->name},{"provider",v.model->provider}};if(v.model->contextWindow)m["contextWindow"]=*v.model->contextWindow;else m["contextWindow"]=nullptr;j["model"]=m;}if(v.contextUsage){j["contextUsage"]={{"tokens",v.contextUsage->tokens?Json(*v.contextUsage->tokens):Json(nullptr)},{"contextWindow",v.contextUsage->contextWindow?Json(*v.contextUsage->contextWindow):Json(nullptr)},{"percent",v.contextUsage->percent?Json(*v.contextUsage->percent):Json(nullptr)}};}Json ps=Json::array();for(auto&p:v.participants){Json x={{"name",p.name},{"role",p.role==Participant::Role::Host?"host":"guest"}};putOptional(x,"readOnly",p.readOnly);ps.push_back(x);}j["participants"]=ps;return j; }

EventFrame parseEvent(const Json& j) {
    const auto t=required<std::string>(j,"t");
    if(t=="welcome") return {{WelcomeEvent{required<std::string>(j,"sessionPath"),required<int>(j,"protocol"),parseHeader(requiredObject(j,"header")),parseSessionState(requiredObject(j,"state")),parseVector<AgentSnapshot>(requiredArray(j,"agents"),parseAgent),required<std::int64_t>(j,"entryCount")}}};
    if(t=="snapshot-chunk") return {{SnapshotChunkEvent{required<std::string>(j,"sessionPath"),parseVector<SessionEntry>(requiredArray(j,"entries"),parseEntry),required<bool>(j,"final")}}};
    if(t=="entry") return {{EntryEvent{required<std::string>(j,"sessionPath"),parseEntry(requiredObject(j,"entry"))}}};
    if(t=="agent-event") return {{AgentEventFrame{required<std::string>(j,"sessionPath"),parseAgentEvent(requiredObject(j,"event"))}}};
    if(t=="state") return {{StateEvent{required<std::string>(j,"sessionPath"),parseSessionState(requiredObject(j,"state"))}}};
    if(t=="bus") { auto channel=required<std::string>(j,"channel");if(!j.contains("data"))throw CodecError("missing required field: data");return {{BusEvent{required<std::string>(j,"sessionPath"),channel,j.at("data")}}}; }
    if(t=="agents") return {{AgentsEvent{required<std::string>(j,"sessionPath"),parseVector<AgentSnapshot>(requiredArray(j,"agents"),parseAgent)}}};
    if(t=="ui-request") return {{UiRequestEvent{required<std::string>(j,"sessionPath"),parseUiRequest(requiredObject(j,"request"))}}};
    if(t=="ui-request-end") return {{UiRequestEndEvent{required<std::string>(j,"sessionPath"),required<std::int64_t>(j,"reqId")}}};
    if(t=="sessions") return {{SessionsEvent{parseVector<DesktopSessionInfo>(requiredArray(j,"sessions"),parseSessionInfo)}}};
    if(t=="session-tabs") return {{SessionTabsEvent{parseVector<DesktopSessionTab>(requiredArray(j,"tabs"),parseTab)}}};
    if(t=="workspace-change") return {{WorkspaceChangeEvent{required<std::string>(j,"workspaceId"),parseVector<FileChange>(requiredArray(j,"changes"),parseFileChange)}}};
    if(t=="document") return {{DocumentEvent{parseDocumentSnapshot(requiredObject(j,"document")),changeOrigin(required<std::string>(j,"origin"))}}};
    if(t=="git") return {{GitEvent{required<std::string>(j,"workspaceId"),parseGitSnapshot(requiredObject(j,"snapshot"))}}};
    if(t=="terminal-data") return {{TerminalDataEvent{required<std::string>(j,"terminalId"),required<std::string>(j,"dataBase64")}}};
    if(t=="terminal-exit") return {{TerminalExitEvent{required<std::string>(j,"terminalId"),optional<std::int64_t>(j,"exitCode"),optional<std::string>(j,"signal")}}};
    if(t=="diagnostics") return {{DiagnosticsEvent{required<std::string>(j,"workspaceId"),parseVector<LspDiagnostic>(requiredArray(j,"diagnostics"),parseDiagnostic)}}};
    if(t=="graph") return {{GraphEvent{required<std::string>(j,"workspaceId"),graphKind(required<std::string>(j,"kind")),parseGraphSnapshot(requiredObject(j,"graph"))}}};
    if(t=="error") return {{ErrorEvent{optional<std::string>(j,"sessionPath"),required<std::string>(j,"code"),required<std::string>(j,"message")}}};
    return {{UnknownEvent{t,j}}};
}

Json encodeEvent(const EventFrame& event) {
    return std::visit([](const auto& e)->Json { using T=std::decay_t<decltype(e)>;
        if constexpr(std::is_same_v<T,UnknownEvent>) return e.raw;
        else if constexpr(std::is_same_v<T,WelcomeEvent>){Json as=Json::array();for(auto&a:e.agents)as.push_back(encodeAgent(a));return {{"t","welcome"},{"sessionPath",e.sessionPath},{"protocol",e.protocol},{"header",encodeHeader(e.header)},{"state",encodeSessionState(e.state)},{"agents",as},{"entryCount",e.entryCount}};}
        else if constexpr(std::is_same_v<T,SnapshotChunkEvent>){Json xs=Json::array();for(auto&x:e.entries)xs.push_back(encodeEntry(x));return {{"t","snapshot-chunk"},{"sessionPath",e.sessionPath},{"entries",xs},{"final",e.final}};}
        else if constexpr(std::is_same_v<T,EntryEvent>)return {{"t","entry"},{"sessionPath",e.sessionPath},{"entry",encodeEntry(e.entry)}};
        else if constexpr(std::is_same_v<T,AgentEventFrame>)return {{"t","agent-event"},{"sessionPath",e.sessionPath},{"event",e.event.payload}};
        else if constexpr(std::is_same_v<T,StateEvent>)return {{"t","state"},{"sessionPath",e.sessionPath},{"state",encodeSessionState(e.state)}};
        else if constexpr(std::is_same_v<T,BusEvent>)return {{"t","bus"},{"sessionPath",e.sessionPath},{"channel",e.channel},{"data",e.data}};
        else if constexpr(std::is_same_v<T,AgentsEvent>){Json xs=Json::array();for(auto&x:e.agents)xs.push_back(encodeAgent(x));return {{"t","agents"},{"sessionPath",e.sessionPath},{"agents",xs}};}
        else if constexpr(std::is_same_v<T,UiRequestEvent>)return {{"t","ui-request"},{"sessionPath",e.sessionPath},{"request",e.request.payload}};
        else if constexpr(std::is_same_v<T,UiRequestEndEvent>)return {{"t","ui-request-end"},{"sessionPath",e.sessionPath},{"reqId",e.reqId}};
        else if constexpr(std::is_same_v<T,SessionsEvent>){Json xs=Json::array();for(auto&x:e.sessions)xs.push_back(encodeSessionInfo(x));return {{"t","sessions"},{"sessions",xs}};}
        else if constexpr(std::is_same_v<T,SessionTabsEvent>){Json xs=Json::array();for(auto&x:e.tabs)xs.push_back(encodeTab(x));return {{"t","session-tabs"},{"tabs",xs}};}
        else if constexpr(std::is_same_v<T,WorkspaceChangeEvent>){Json xs=Json::array();for(auto&x:e.changes)xs.push_back(encodeFileChange(x));return {{"t","workspace-change"},{"workspaceId",e.workspaceId},{"changes",xs}};}
        else if constexpr(std::is_same_v<T,DocumentEvent>)return {{"t","document"},{"document",encodeDocumentSnapshot(e.document)},{"origin",text(e.origin)}};
        else if constexpr(std::is_same_v<T,GitEvent>)return {{"t","git"},{"workspaceId",e.workspaceId},{"snapshot",encodeGitSnapshot(e.snapshot)}};
        else if constexpr(std::is_same_v<T,TerminalDataEvent>)return {{"t","terminal-data"},{"terminalId",e.terminalId},{"dataBase64",e.dataBase64}};
        else if constexpr(std::is_same_v<T,TerminalExitEvent>){Json j={{"t","terminal-exit"},{"terminalId",e.terminalId},{"exitCode",e.exitCode?Json(*e.exitCode):Json(nullptr)}};putOptional(j,"signal",e.signal);return j;}
        else if constexpr(std::is_same_v<T,DiagnosticsEvent>){Json xs=Json::array();for(auto&x:e.diagnostics)xs.push_back(encodeDiagnostic(x));return {{"t","diagnostics"},{"workspaceId",e.workspaceId},{"diagnostics",xs}};}
        else if constexpr(std::is_same_v<T,GraphEvent>)return {{"t","graph"},{"workspaceId",e.workspaceId},{"kind",text(e.kind)},{"graph",encodeGraphSnapshot(e.graph)}};
        else {Json j={{"t","error"},{"code",e.code},{"message",e.message}};putOptional(j,"sessionPath",e.sessionPath);return j;}
    },event.payload);
}

DesktopFrame parseFrame(std::string_view input) {
    Json j;try{j=Json::parse(input);}catch(const Json::exception& e){throw CodecError(std::string("invalid JSON: ")+e.what());}
    const auto t=required<std::string>(j,"t");
    if(t=="request"){auto method=required<std::string>(j,"method");if(!isSupportedMethod(method))throw CodecError("unsupported request method: "+method);const auto&params=requiredObject(j,"params");validateRequestParams(method,params);return RequestFrame{required<RequestId>(j,"id"),method,params};}
    if(t=="response"){auto method=required<std::string>(j,"method");if(!isSupportedMethod(method))throw CodecError("unsupported response method: "+method);ResponseFrame r{required<RequestId>(j,"id"),method,std::nullopt,std::nullopt};if(auto it=j.find("result");it!=j.end())r.result=*it;if(auto it=j.find("error");it!=j.end()){if(!it->is_object())throw CodecError("invalid response error");r.error=ResponseError{required<std::string>(*it,"code"),required<std::string>(*it,"message")};}if(bool(r.result)==bool(r.error))throw CodecError("response must contain exactly one of result or error");if(r.result)validateResponseResult(method,*r.result);return r;}
    return parseEvent(j);
}
Json encodeFrameJson(const DesktopFrame& f){return std::visit([](const auto&x)->Json{using T=std::decay_t<decltype(x)>;if constexpr(std::is_same_v<T,RequestFrame>){if(!isSupportedMethod(x.method))throw CodecError("unsupported request method: "+x.method);validateRequestParams(x.method,x.params);return {{"t","request"},{"id",x.id},{"method",x.method},{"params",x.params}};}else if constexpr(std::is_same_v<T,ResponseFrame>){if(!isSupportedMethod(x.method))throw CodecError("unsupported response method: "+x.method);if(bool(x.result)==bool(x.error))throw CodecError("response must contain exactly one of result or error");if(x.result)validateResponseResult(x.method,*x.result);Json j={{"t","response"},{"id",x.id},{"method",x.method}};if(x.result)j["result"]=*x.result;if(x.error)j["error"]={{"code",x.error->code},{"message",x.error->message}};return j;}else return encodeEvent(x);},f);}
std::string encodeFrame(const DesktopFrame& frame){return encodeFrameJson(frame).dump();}

} // namespace chud::json_codec
