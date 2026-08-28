#include "graph/force_graph.h"
#include "graph/graph_view.h"
#include "theme/anim.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace {

using namespace chud;

bool close(float a, float b, float epsilon = 1.0e-4F) {
  return std::abs(a - b) <= epsilon;
}

float distance(GraphVec2 a, GraphVec2 b) {
  const float x = a.x - b.x;
  const float y = a.y - b.y;
  return std::sqrt(x * x + y * y);
}

GraphNode node(std::string id, std::string label, std::string kind,
               std::string group = {}) {
  GraphNode value;
  value.id = std::move(id);
  value.label = std::move(label);
  value.kind = std::move(kind);
  if (!group.empty()) {
    value.group = std::move(group);
  }
  value.state = GraphState::Stable;
  return value;
}

GraphEdge edge(std::string id, std::string source, std::string target) {
  GraphEdge value;
  value.id = std::move(id);
  value.source = std::move(source);
  value.target = std::move(target);
  value.kind = "link";
  value.state = GraphState::Stable;
  return value;
}

GraphSnapshot basicSnapshot(std::int64_t revision = 1) {
  GraphSnapshot snapshot;
  snapshot.revision = revision;
  snapshot.nodes = {node("a", "Alpha", "file"), node("b", "Beta", "symbol"),
                    node("c", "Gamma", "symbol")};
  snapshot.edges = {edge("ab", "a", "b"), edge("bc", "b", "c")};
  return snapshot;
}

void testDeterminismAndBounds() {
  ForceGraphConfig config;
  config.deterministicSeed = 42;
  config.worldMin = {-240.0F, -180.0F};
  config.worldMax = {240.0F, 180.0F};
  config.initialPlacementRadius = 120.0F;

  const std::vector<ForceNodeInput> forwardNodes = {
      {"a", 13.0F, false, std::nullopt}, {"b", 18.0F, false, std::nullopt},
      {"c", 11.0F, false, std::nullopt}, {"d", 20.0F, false, std::nullopt}};
  const std::vector<ForceNodeInput> reverseNodes(forwardNodes.rbegin(), forwardNodes.rend());
  const std::vector<ForceEdgeInput> forwardEdges = {
      {"ab", "a", "b", 70.0F, 1.0F}, {"bc", "b", "c", 80.0F, 0.8F},
      {"cd", "c", "d", 65.0F, 1.2F}, {"ad", "a", "d", 110.0F, 0.5F}};
  const std::vector<ForceEdgeInput> reverseEdges(forwardEdges.rbegin(), forwardEdges.rend());

  ForceGraph first(config);
  ForceGraph second(config);
  first.update(forwardNodes, forwardEdges);
  second.update(reverseNodes, reverseEdges);
  for (int frame = 0; frame < 180; ++frame) {
    first.step(1.0F / 60.0F);
    second.step(1.0F / 60.0F);
  }

  assert(first.nodes().size() == second.nodes().size());
  for (std::size_t index = 0; index < first.nodes().size(); ++index) {
    const ForceNodeState& a = first.nodes()[index];
    const ForceNodeState& b = second.nodes()[index];
    assert(a.id == b.id);
    assert(close(a.position.x, b.position.x, 1.0e-6F));
    assert(close(a.position.y, b.position.y, 1.0e-6F));
    assert(a.position.x >= config.worldMin.x + a.radius - 1.0e-4F);
    assert(a.position.x <= config.worldMax.x - a.radius + 1.0e-4F);
    assert(a.position.y >= config.worldMin.y + a.radius - 1.0e-4F);
    assert(a.position.y <= config.worldMax.y - a.radius + 1.0e-4F);
  }
  assert(first.stats().springsApplied == forwardEdges.size());
}

void testIncrementalPositionStability() {
  ForceGraph graph;
  graph.update({{"a", 12.0F, false, GraphVec2{-20.0F, 0.0F}},
                {"b", 12.0F, false, GraphVec2{20.0F, 0.0F}}},
               {{"ab", "a", "b", 60.0F, 1.0F}});
  for (int frame = 0; frame < 20; ++frame) {
    graph.step(1.0F / 60.0F);
  }
  const GraphVec2 aBefore = graph.findNode("a")->position;
  const GraphVec2 bBefore = graph.findNode("b")->position;

  graph.update({{"c", 12.0F, false, std::nullopt},
                {"b", 12.0F, false, GraphVec2{999.0F, 999.0F}},
                {"a", 12.0F, false, GraphVec2{-999.0F, -999.0F}}},
               {{"bc", "b", "c", 60.0F, 1.0F},
                {"ab", "a", "b", 60.0F, 1.0F}});
  assert(graph.findNode("a")->position == aBefore);
  assert(graph.findNode("b")->position == bBefore);
  assert(graph.findNode("c") != nullptr);
}

void testCollisionAndCooling() {
  ForceGraphConfig config;
  config.repulsionStrength = 0.0F;
  config.springStrength = 0.0F;
  config.centeringStrength = 0.0F;
  config.collisionIterations = 4;
  config.coolingRate = 2.0F;
  config.minimumTemperature = 0.02F;
  ForceGraph graph(config);
  graph.update({{"left", 20.0F, false, GraphVec2{}},
                {"right", 20.0F, false, GraphVec2{}}},
               {});

  float priorTemperature = graph.temperature();
  for (int frame = 0; frame < 240; ++frame) {
    graph.step(1.0F / 60.0F);
    assert(graph.temperature() <= priorTemperature + 1.0e-6F);
    priorTemperature = graph.temperature();
  }
  const ForceNodeState* left = graph.findNode("left");
  const ForceNodeState* right = graph.findNode("right");
  assert(left != nullptr && right != nullptr);
  assert(distance(left->position, right->position) >=
         left->radius + right->radius + config.collisionPadding - 1.0e-3F);
  assert(graph.cooled());
  assert(graph.stats().nodeCount == 2);
}

void testDeterministicGitLanes() {
  GraphSnapshot first;
  first.revision = 4;
  first.nodes = {node("c3", "three", "commit", "feature"),
                 node("c1", "one", "commit", "main"),
                 node("c2", "two", "commit", "main")};
  first.edges = {edge("e2", "c3", "c2"), edge("e1", "c2", "c1")};
  GraphSnapshot reverse = first;
  std::reverse(reverse.nodes.begin(), reverse.nodes.end());
  std::reverse(reverse.edges.begin(), reverse.edges.end());

  const auto layout = GraphView::computeGitLaneLayout(first);
  const auto reversedLayout = GraphView::computeGitLaneLayout(reverse);
  assert(layout == reversedLayout);
  assert(layout.at("c1").y == layout.at("c2").y);
  assert(layout.at("c1").x < layout.at("c2").x);
  assert(layout.at("c3").y != layout.at("c1").y);

  GraphView view;
  view.update(GraphKind::Git, first);
  assert(view.gitLaneTarget("c1") == std::optional(layout.at("c1")));
  assert(view.gitLaneTarget("c3") == std::optional(layout.at("c3")));
}

void testCameraTargetAuthorityAndSearch() {
  GraphView view;
  view.update(GraphKind::Code, basicSnapshot());
  assert(view.fit(ImVec2(900.0F, 600.0F)));
  assert(view.cameraTarget().has_value());
  assert(view.cameraTarget()->reason == GraphCameraReason::Fit);
  const std::uint64_t fitSerial = view.cameraTarget()->serial;

  view.setSearch("gamma");
  assert((view.searchMatches() == std::vector<std::string>{"c"}));
  assert(view.focusFirstSearchResult(ImVec2(900.0F, 600.0F)));
  assert(view.cameraTarget().has_value());
  assert(view.cameraTarget()->reason == GraphCameraReason::Search);
  assert(view.cameraTarget()->serial > fitSerial);

  view.pan({10.0F, 0.0F});
  assert(!view.cameraTarget().has_value());

  view.setScope(std::string("a"), 1);
  assert(view.visible("a"));
  assert(view.visible("b"));
  assert(!view.visible("c"));
  GraphFilter filter;
  filter.nodeKinds.insert("file");
  view.setFilter(std::move(filter));
  assert(view.visible("a"));
  assert(!view.visible("b"));
}

void testCacheSchemaWorkspaceAndKind() {
  GraphView source;
  source.setWorkspace("workspace-a");
  source.update(GraphKind::Code, basicSnapshot());
  assert(source.solver(GraphKind::Code).setNodePosition("a", {71.0F, -33.0F}));
  assert(source.solver(GraphKind::Code).setPinned("a", true));
  source.requestCamera({{12.0F, 24.0F}, 1.7F}, GraphCameraReason::Restore, false);
  const std::string payload = source.exportCache("workspace-a", GraphKind::Code);

  nlohmann::json parsed = nlohmann::json::parse(payload);
  assert(parsed.at("schema") == GraphView::kCacheSchemaVersion);
  assert(parsed.at("workspace") == "workspace-a");
  assert(parsed.at("kind") == "code");
  assert(GraphView::cacheKey("workspace-a", GraphKind::Code) !=
         GraphView::cacheKey("workspace-a", GraphKind::Git));

  GraphView restored;
  restored.setWorkspace("workspace-a");
  restored.update(GraphKind::Code, basicSnapshot());
  assert(restored.importCache(payload, "workspace-a", GraphKind::Code));
  const ForceNodeState* restoredNode = restored.solver(GraphKind::Code).findNode("a");
  assert(restoredNode != nullptr);
  assert(close(restoredNode->position.x, 71.0F));
  assert(close(restoredNode->position.y, -33.0F));
  assert(restoredNode->pinned);
  assert(close(restored.camera().zoom, 1.7F));
  assert(!restored.importCache(payload, "workspace-b", GraphKind::Code));
  assert(!restored.importCache(payload, "workspace-a", GraphKind::Git));

  parsed["schema"] = GraphView::kCacheSchemaVersion + 1;
  assert(!restored.importCache(parsed.dump(), "workspace-a", GraphKind::Code));
}

void testReducedMotionAndActions() {
  anim::forgetAll();
  anim::setMotionScale(0.0F);
  GraphSnapshot snapshot = basicSnapshot();
  snapshot.nodes[0].meta["uri"] = std::string("file:///src/a.cpp");
  snapshot.nodes[0].meta["line"] = 7.0;
  snapshot.nodes[0].meta["column"] = 3.0;

  GraphView view;
  view.update(GraphKind::Code, snapshot);
  view.tick(1.0F / 60.0F);
  const auto visual = view.nodeVisual("a");
  assert(visual.has_value());
  assert(visual->alpha == 1.0F);
  assert(visual->scale == 1.0F);

  const ForceNodeState* forceNode = view.solver(GraphKind::Code).findNode("a");
  assert(forceNode != nullptr);
  const ImVec2 viewport(800.0F, 600.0F);
  const GraphVec2 screen = view.worldToScreen(forceNode->position, viewport);
  assert(view.clickAt(screen, viewport));
  assert(view.selection() == std::optional<std::string>("a"));

  int opened = 0;
  SourceLocation openedAt;
  view.setOpenSourceCallback([&](const SourceLocation& location) {
    ++opened;
    openedAt = location;
  });
  assert(view.performListAction("a", GraphListAction::OpenSource, viewport));
  assert(opened == 1);
  assert(openedAt == (SourceLocation{"file:///src/a.cpp", 7, 3}));
  assert(view.performListAction("a", GraphListAction::TogglePin, viewport));
  assert(view.solver(GraphKind::Code).findNode("a")->pinned);

  const std::vector<GraphAccessibleItem> items = view.accessibleItems();
  assert(items.size() == 3);
  assert(items.front().id == "a");
  assert(items.front().selected);
  assert(items.front().hasSource);

  GraphSnapshot leaving = snapshot;
  leaving.revision = 2;
  leaving.nodes.erase(leaving.nodes.begin());
  leaving.edges.erase(leaving.edges.begin());
  view.update(GraphKind::Code, leaving);
  view.tick(1.0F / 60.0F);
  assert(view.solver(GraphKind::Code).findNode("a") == nullptr);
  assert(!view.selection().has_value());

  anim::setMotionScale(1.0F);
  anim::forgetAll();
}

}  // namespace

int main() {
  testDeterminismAndBounds();
  testIncrementalPositionStability();
  testCollisionAndCooling();
  testDeterministicGitLanes();
  testCameraTargetAuthorityAndSearch();
  testCacheSchemaWorkspaceAndKind();
  testReducedMotionAndActions();
  std::cout << "graph tests passed\n";
  return 0;
}
