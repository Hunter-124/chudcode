#include "graph/session_dag.h"
#include "graph/session_dag_view.h"

#include <algorithm>
#include <cassert>
#include <iostream>
#include <string>

namespace {

using namespace chud;
using namespace chud::session_graph;

const SessionDagNode& findNode(const SessionDag& dag, const std::string& id) {
    const auto found = std::find_if(dag.nodes.begin(), dag.nodes.end(),
                                    [&](const SessionDagNode& node) {
                                        return node.id == id;
                                    });
    assert(found != dag.nodes.end());
    return *found;
}

SessionSnapshot snapshotFixture() {
    SessionSnapshot snapshot;
    snapshot.header = SessionHeader{"session-id", std::string("Build Chudcode"),
                                    "2026-08-28T00:00:00Z", "/workspace"};
    SessionState state;
    state.isStreaming = true;
    state.queuedMessageCount = 0;
    state.sessionName = "Build Chudcode";
    state.cwd = "/workspace";
    snapshot.state = state;
    snapshot.agents = {
        AgentSnapshot{"main", "Main", AgentSnapshot::Kind::Main, std::nullopt,
                      AgentSnapshot::Status::Running, true, 100, 500},
        AgentSnapshot{"child", "Renderer", AgentSnapshot::Kind::Sub,
                      std::string("main"), AgentSnapshot::Status::Idle, true, 200, 450},
        AgentSnapshot{"orphan", "Recovered worker", AgentSnapshot::Kind::Sub,
                      std::string("missing"), AgentSnapshot::Status::Parked, true,
                      300, 400},
    };
    return snapshot;
}

copilot::TranscriptProjection projectionFixture() {
    copilot::TranscriptProjection projection;
    projection.tasks = {
        copilot::TaskItem{"plan", "Plan DAG", "completed", std::nullopt, "Design"},
        copilot::TaskItem{"render", "Render graph", "in_progress",
                          std::string("plan"), "Implementation"},
        copilot::TaskItem{"lost", "Recover state", "blocked",
                          std::string("missing-task"), "Recovery"},
    };
    copilot::TranscriptRow tool;
    tool.id = "tool-1";
    tool.kind = copilot::TranscriptKind::Tool;
    tool.title = "terminal.write";
    tool.text = "Run focused build";
    tool.order = 4;
    tool.detail = Json{{"id", "call-1"},
                       {"arguments", Json{{"path", "/workspace/gui/app.cpp"}}}};
    projection.rows.push_back(tool);

    copilot::TranscriptRow result;
    result.id = "tool-result-1";
    result.kind = copilot::TranscriptKind::ToolResult;
    result.title = "terminal.write result";
    result.text = "Build artifact created";
    result.detail = Json{{"toolCallId", "call-1"},
                         {"artifactUri", "artifact://build-log"}};
    result.order = 5;
    projection.rows.push_back(result);
    projection.activeTools.push_back(
        copilot::ActiveTool{"call-2", "read", "Inspect source",
                            Json{{"uri", "file:///workspace/gui/app.cpp"}}});

    copilot::TranscriptRow retry;
    retry.id = "retry-1";
    retry.kind = copilot::TranscriptKind::Status;
    retry.title = "Retrying interrupted run";
    retry.text = "Resume from last durable event";
    retry.detail = Json{{"checkpointPath", "/workspace/.omp/checkpoint"}};
    retry.order = 6;
    projection.rows.push_back(retry);
    return projection;
}

void testDeterministicDagAndOrphans() {
    const SessionSnapshot snapshot = snapshotFixture();
    const auto projection = projectionFixture();
    const SessionDag first = buildSessionDag("/session.jsonl", &snapshot, projection);
    const SessionDag second = buildSessionDag("/session.jsonl", &snapshot, projection);
    assert(first == second);
    assert(first.nodes.size() == 11);
    assert(first.edges.size() == 10);

    const auto& main = findNode(first, "agent:main");
    assert(main.parentId == "session:root");
    assert(main.state == NodeState::Active);
    const auto& child = findNode(first, "agent:child");
    assert(child.parentId == "agent:main");
    const auto& orphan = findNode(first, "agent:orphan");
    assert(orphan.parentId == "session:root");
    assert(orphan.orphan);
    assert(orphan.recoverable);

    const auto& nestedTask = findNode(first, "task:render");
    assert(nestedTask.parentId == "task:plan");
    assert(nestedTask.state == NodeState::Active);
    const auto& blocked = findNode(first, "task:lost");
    assert(blocked.orphan);
    assert(blocked.recoverable);
    const auto& toolNode = findNode(first, "tool:call-1");
    assert(toolNode.parentId == "agent:main");
    assert(toolNode.state == NodeState::Done);
    assert(toolNode.resources.size() == 2);
    const auto& recovery = findNode(first, "recovery:retry-1");
    const auto& activeTool = findNode(first, "tool:call-2");
    assert(activeTool.state == NodeState::Active);
    assert(activeTool.resources.size() == 1);
    assert(recovery.recoverable);
    assert(recovery.resources.size() == 1);
}

void testMissingSnapshotRemainsHonest() {
    const copilot::TranscriptProjection projection;
    const SessionDag dag = buildSessionDag("missing", nullptr, projection);
    assert(dag.nodes.size() == 1);
    assert(dag.nodes.front().state == NodeState::Unknown);
    assert(dag.edges.empty());
}
void testLayoutStaysStableAsEventsAppend() {
    const SessionSnapshot snapshot = snapshotFixture();
    auto projection = projectionFixture();
    SessionDagView view;
    view.sync("/session.jsonl", &snapshot, projection);
    const auto mainBefore = view.layoutPosition("agent:main");
    const auto childBefore = view.layoutPosition("agent:child");
    assert(mainBefore.has_value());
    assert(childBefore.has_value());

    projection.tasks.push_back(
        copilot::TaskItem{"late", "Late task", "pending", std::nullopt, "Follow-up"});
    view.sync("/session.jsonl", &snapshot, projection);
    assert(view.layoutPosition("agent:main") == mainBefore);
    assert(view.layoutPosition("agent:child") == childBefore);
    assert(view.layoutPosition("task:late").has_value());
}


void testMermaidExportIsStableAndEscaped() {
    SessionSnapshot snapshot = snapshotFixture();
    snapshot.header->title = "Review \"quoted\" <branch>";
    snapshot.state->sessionName.reset();
    const SessionDag dag = buildSessionDag("/session.jsonl", &snapshot,
                                           projectionFixture());
    const std::string mermaid = toMermaid(dag);
    assert(mermaid.starts_with("flowchart LR\n"));
    assert(mermaid.find("subgraph SESSION") != std::string::npos);
    assert(mermaid.find("Review &quot;quoted&quot; &lt;branch&gt;") !=
           std::string::npos);
    assert(mermaid.find("n0 -->|hosts| n1") != std::string::npos);
    assert(mermaid.find("class n1 agent;") != std::string::npos);
    assert(mermaid.find("class n1 active;") != std::string::npos);
    assert(mermaid.find("classDef recovery") != std::string::npos);
    assert(mermaid == toMermaid(dag));
}

}  // namespace

int main() {
    testDeterministicDagAndOrphans();
    testMissingSnapshotRemainsHonest();
    testMermaidExportIsStableAndEscaped();
    testLayoutStaysStableAsEventsAppend();
    std::cout << "session DAG tests passed\n";
    return 0;
}
