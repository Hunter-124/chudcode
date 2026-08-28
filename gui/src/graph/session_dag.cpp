#include "graph/session_dag.h"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace chud::session_graph {
namespace {

std::string lower(std::string_view value) {
    std::string result(value);
    std::transform(result.begin(), result.end(), result.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return result;
}

bool containsAny(std::string_view value,
                 std::initializer_list<std::string_view> needles) {
    const std::string folded = lower(value);
    return std::any_of(needles.begin(), needles.end(), [&](std::string_view needle) {
        return folded.find(needle) != std::string::npos;
    });
}

NodeState agentState(AgentSnapshot::Status status) {
    switch (status) {
        case AgentSnapshot::Status::Running: return NodeState::Active;
        case AgentSnapshot::Status::Idle: return NodeState::Idle;
        case AgentSnapshot::Status::Parked: return NodeState::Parked;
        case AgentSnapshot::Status::Aborted: return NodeState::Failed;
    }
    return NodeState::Unknown;
}

NodeState taskState(std::string_view state) {
    const std::string value = lower(state);
    if (value == "in_progress" || value == "in-progress" || value == "running" ||
        value == "active")
        return NodeState::Active;
    if (value == "completed" || value == "complete" || value == "done")
        return NodeState::Done;
    if (value == "abandoned" || value == "failed" || value == "error")
        return NodeState::Failed;
    if (value == "blocked" || value == "parked") return NodeState::Parked;
    if (value == "pending" || value == "queued") return NodeState::Pending;
    return NodeState::Unknown;
}

std::string nonEmpty(std::string_view value, std::string_view fallback) {
    return value.empty() ? std::string(fallback) : std::string(value);
}

std::string mermaidEscape(std::string_view value) {
    std::string result;
    result.reserve(value.size());
    for (char character : value) {
        switch (character) {
            case '&': result += "&amp;"; break;
            case '"': result += "&quot;"; break;
            case '<': result += "&lt;"; break;
            case '>': result += "&gt;"; break;
            case '\r':
            case '\n': result.push_back(' '); break;
            default: result.push_back(character); break;
        }
    }
    return result;
}

void addResource(std::vector<std::string>& resources, std::string value) {
    if (value.empty() || value.size() > 512) return;
    if (std::find(resources.begin(), resources.end(), value) == resources.end())
        resources.push_back(std::move(value));
}

void collectResources(const Json& value, std::vector<std::string>& resources,
                      int depth = 0, std::string_view field = {}) {
    if (depth > 5) return;
    const std::string key = lower(field);
    const bool resourceField = key.find("path") != std::string::npos ||
                               key.find("file") != std::string::npos ||
                               key.find("uri") != std::string::npos ||
                               key.find("artifact") != std::string::npos;
    if (value.is_string()) {
        const std::string text = value.get<std::string>();
        if (resourceField || text.starts_with("artifact://") ||
            text.starts_with("file://"))
            addResource(resources, text);
        return;
    }
    if (value.is_array()) {
        for (const auto& item : value)
            collectResources(item, resources, depth + 1, field);
        return;
    }
    if (!value.is_object()) return;
    for (auto iterator = value.begin(); iterator != value.end(); ++iterator)
        collectResources(iterator.value(), resources, depth + 1, iterator.key());
}

}  // namespace

std::string_view nodeKindLabel(NodeKind kind) noexcept {
    switch (kind) {
        case NodeKind::Session: return "Session";
        case NodeKind::Agent: return "Agent";
        case NodeKind::Task: return "Task";
        case NodeKind::Tool: return "Tool";
        case NodeKind::Recovery: return "Recovery";
    }
    return "Unknown";
}

std::string_view nodeStateLabel(NodeState state) noexcept {
    switch (state) {
        case NodeState::Active: return "active";
        case NodeState::Idle: return "idle";
        case NodeState::Pending: return "pending";
        case NodeState::Done: return "done";
        case NodeState::Parked: return "parked";
        case NodeState::Failed: return "failed";
        case NodeState::Unknown: return "unknown";
    }
    return "unknown";
}

SessionDag buildSessionDag(std::string_view sessionPath,
                           const SessionSnapshot* snapshot,
                           const copilot::TranscriptProjection& projection) {
    SessionDag dag;
    dag.sessionPath = std::string(sessionPath);
    std::uint64_t ordinal = 0;

    std::string sessionLabel = "OMP session";
    std::string sessionDetail = std::string(sessionPath);
    if (snapshot != nullptr) {
        if (snapshot->state && snapshot->state->sessionName)
            sessionLabel = *snapshot->state->sessionName;
        else if (snapshot->header && snapshot->header->title)
            sessionLabel = *snapshot->header->title;
        else if (snapshot->header && !snapshot->header->id.empty())
            sessionLabel = snapshot->header->id;
        if (snapshot->state && !snapshot->state->cwd.empty())
            sessionDetail = snapshot->state->cwd;
        else if (snapshot->header && !snapshot->header->cwd.empty())
            sessionDetail = snapshot->header->cwd;
    }

    const std::string rootId = "session:root";
    dag.nodes.push_back(SessionDagNode{rootId, {}, std::string(sessionPath),
                                       std::move(sessionLabel), std::move(sessionDetail),
                                       NodeKind::Session,
                                       snapshot != nullptr ? NodeState::Active
                                                           : NodeState::Unknown,
                                       ordinal++});
    if (snapshot == nullptr) return dag;

    std::vector<const AgentSnapshot*> agents;
    agents.reserve(snapshot->agents.size());
    for (const auto& agent : snapshot->agents) agents.push_back(&agent);
    std::stable_sort(agents.begin(), agents.end(), [](const auto* left, const auto* right) {
        if (left->createdAt != right->createdAt) return left->createdAt < right->createdAt;
        return left->id < right->id;
    });

    std::unordered_set<std::string> agentIds;
    std::string mainAgentNode = rootId;
    for (const auto* agent : agents) {
        agentIds.insert(agent->id);
        if (agent->kind == AgentSnapshot::Kind::Main) mainAgentNode = "agent:" + agent->id;
    }
    for (const auto* agent : agents) {
        const std::string id = "agent:" + agent->id;
        std::string parent = rootId;
        bool orphan = false;
        if (agent->kind == AgentSnapshot::Kind::Sub && agent->parentId) {
            if (agentIds.contains(*agent->parentId))
                parent = "agent:" + *agent->parentId;
            else
                orphan = true;
        }
        const NodeState state = agentState(agent->status);
        std::string detail = agent->kind == AgentSnapshot::Kind::Main ? "main agent" : "subagent";
        detail += " · ";
        detail += nodeStateLabel(state);
        if (orphan) detail += " · parent unavailable";
        dag.nodes.push_back(SessionDagNode{id, parent, agent->id,
                                           nonEmpty(agent->displayName, agent->id),
                                           std::move(detail), NodeKind::Agent, state,
                                           ordinal++, agent->createdAt,
                                           agent->lastActivity, orphan,
                                           state == NodeState::Parked ||
                                               state == NodeState::Failed});
        dag.edges.push_back({parent, id,
                             orphan ? "orphan" : agent->kind == AgentSnapshot::Kind::Main
                                                          ? "hosts"
                                                          : "spawns"});
    }

    std::unordered_set<std::string> taskIds;
    for (const auto& task : projection.tasks) taskIds.insert(task.id);
    for (const auto& task : projection.tasks) {
        const std::string id = "task:" + task.id;
        std::string parent = rootId;
        bool orphan = false;
        if (task.parentId) {
            if (taskIds.contains(*task.parentId))
                parent = "task:" + *task.parentId;
            else
                orphan = true;
        }
        const NodeState state = taskState(task.state);
        std::string detail = task.phase.empty() ? task.state
                                                : task.phase + " · " + task.state;
        if (orphan) detail += " · parent unavailable";
        dag.nodes.push_back(SessionDagNode{id, parent, task.id,
                                           nonEmpty(task.title, "Task"), std::move(detail),
                                           NodeKind::Task, state, ordinal++, 0, 0, orphan,
                                           state == NodeState::Parked});
        dag.edges.push_back({parent, id, task.parentId ? "depends" : "tracks"});
    }

    std::unordered_map<std::string, const copilot::TranscriptRow*> toolResults;
    for (const auto& row : projection.rows) {
        if (row.kind != copilot::TranscriptKind::ToolResult ||
            !row.detail.is_object())
            continue;
        const std::string callId = row.detail.value("toolCallId", std::string{});
        if (!callId.empty()) toolResults[callId] = &row;
    }

    std::unordered_set<std::string> activeToolIds;
    for (const auto& tool : projection.activeTools) activeToolIds.insert(tool.id);

    std::unordered_set<std::string> toolIds;
    for (const auto& row : projection.rows) {
        if (row.kind != copilot::TranscriptKind::Tool) continue;
        const std::string callId = row.detail.is_object()
                                       ? row.detail.value("id", row.id)
                                       : row.id;
        const std::string id = "tool:" + callId;
        if (!toolIds.insert(id).second) continue;
        const auto result = toolResults.find(callId);
        const NodeState state =
            result != toolResults.end()
                ? (result->second->failed ? NodeState::Failed : NodeState::Done)
                : row.live || activeToolIds.contains(callId) ? NodeState::Active
                                                             : NodeState::Done;
        SessionDagNode node{id, mainAgentNode, callId,
                            nonEmpty(row.title, "Tool"),
                            row.text.empty() ? row.meta : row.text,
                            NodeKind::Tool, state, ordinal++};
        collectResources(row.detail, node.resources);
        if (result != toolResults.end()) {
            if (!result->second->text.empty()) node.detail = result->second->text;
            collectResources(result->second->detail, node.resources);
        }
        dag.nodes.push_back(std::move(node));
        dag.edges.push_back({mainAgentNode, id, "runs"});
    }
    for (const auto& tool : projection.activeTools) {
        const std::string id = "tool:" + tool.id;
        if (!toolIds.insert(id).second) continue;
        SessionDagNode node{id, mainAgentNode, tool.id,
                            nonEmpty(tool.name, "Tool"), tool.intent,
                            NodeKind::Tool, NodeState::Active, ordinal++};
        collectResources(tool.arguments, node.resources);
        dag.nodes.push_back(std::move(node));
        dag.edges.push_back({mainAgentNode, id, "runs"});
    }

    for (const auto& row : projection.rows) {
        if (row.kind != copilot::TranscriptKind::Status &&
            row.kind != copilot::TranscriptKind::System)
            continue;
        const std::string searchable = row.title + " " + row.text;
        if (!containsAny(searchable,
                         {"recover", "retry", "resume", "revive", "abort", "interrupt"}))
            continue;
        const std::string id = "recovery:" + row.id;
        const NodeState state = row.failed ? NodeState::Failed
                                          : row.live ? NodeState::Active
                                                     : NodeState::Done;
        SessionDagNode node{id, rootId, row.id,
                            nonEmpty(row.title, "Recovery event"), row.text,
                            NodeKind::Recovery, state, ordinal++, 0, 0,
                            false, true};
        collectResources(row.detail, node.resources);
        dag.nodes.push_back(std::move(node));
        dag.edges.push_back({rootId, id, "recovery"});
    }

    return dag;
}

std::string toMermaid(const SessionDag& dag) {
    std::ostringstream output;
    output << "flowchart LR\n";
    output << "  classDef session fill:#f28216,color:#111827,stroke:#b45b08,stroke-width:2px;\n";
    output << "  classDef agent fill:#eaf2fb,color:#1f2631,stroke:#196fa3;\n";
    output << "  classDef task fill:#f7f9fc,color:#1f2631,stroke:#535e6e;\n";
    output << "  classDef tool fill:#eef8f1,color:#1f2631,stroke:#2b914b;\n";
    output << "  classDef recovery fill:#fff5e6,color:#1f2631,stroke:#9d660d;\n";
    output << "  classDef failed stroke:#c23531,stroke-width:3px;\n";
    output << "  classDef active stroke:#f28216,stroke-width:3px;\n";
    output << "  classDef parked stroke:#9d660d,stroke-dasharray:5 3;\n";
    output << "  subgraph SESSION[\"OMP session execution\"]\n";

    std::unordered_map<std::string, std::string> ids;
    ids.reserve(dag.nodes.size());
    for (std::size_t index = 0; index < dag.nodes.size(); ++index) {
        const auto& node = dag.nodes[index];
        const std::string id = "n" + std::to_string(index);
        ids.emplace(node.id, id);
        const std::string label = mermaidEscape(node.label);
        output << "    " << id;
        switch (node.kind) {
            case NodeKind::Session: output << "((\"" << label << "\"))"; break;
            case NodeKind::Agent: output << "[\"" << label << "\"]"; break;
            case NodeKind::Task: output << "(\"" << label << "\")"; break;
            case NodeKind::Tool: output << "{{\"" << label << "\"}}"; break;
            case NodeKind::Recovery: output << "[\"Recovery: " << label << "\"]"; break;
        }
        output << "\n";
    }
    for (const auto& edge : dag.edges) {
        const auto source = ids.find(edge.source);
        const auto target = ids.find(edge.target);
        if (source == ids.end() || target == ids.end()) continue;
        output << "    " << source->second << " -->";
        if (!edge.label.empty()) output << "|" << mermaidEscape(edge.label) << "|";
        output << " " << target->second << "\n";
    }
    output << "  end\n";
    for (std::size_t index = 0; index < dag.nodes.size(); ++index) {
        const auto& node = dag.nodes[index];
        const std::string id = "n" + std::to_string(index);
        output << "  class " << id << " " << lower(nodeKindLabel(node.kind)) << ";\n";
        if (node.state == NodeState::Active || node.state == NodeState::Failed ||
            node.state == NodeState::Parked)
            output << "  class " << id << " " << nodeStateLabel(node.state) << ";\n";
    }
    return output.str();
}

}  // namespace chud::session_graph
