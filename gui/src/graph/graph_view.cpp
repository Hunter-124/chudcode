#include "graph/graph_view.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cctype>
#include <limits>
#include <queue>
#include <set>
#include <utility>

#include <nlohmann/json.hpp>

#include "theme/anim.h"
#include "theme/theme.h"

namespace chud {
namespace {

constexpr float kMinZoom = 0.10F;
constexpr float kMaxZoom = 5.0F;
constexpr float kNodeRadius = 18.0F;
constexpr float kGitNodeRadius = 15.0F;
constexpr float kAnimationEpsilon = 0.002F;

std::size_t sceneIndex(GraphKind kind) {
  switch (kind) {
    case GraphKind::Code:
      return 0;
    case GraphKind::Git:
      return 1;
    case GraphKind::Agent:
      return 2;
  }
  return 0;
}

std::string_view kindName(GraphKind kind) {
  switch (kind) {
    case GraphKind::Code:
      return "code";
    case GraphKind::Git:
      return "git";
    case GraphKind::Agent:
      return "agent";
  }
  return "code";
}

std::uint32_t hashText(std::string_view text, std::uint64_t seed = 2166136261U) {
  std::uint32_t hash = static_cast<std::uint32_t>(seed);
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 16777619U;
  }
  return hash == 0U ? 1U : hash;
}

bool containsInsensitive(std::string_view haystack, std::string_view needle) {
  if (needle.empty()) {
    return true;
  }
  return std::search(haystack.begin(), haystack.end(), needle.begin(), needle.end(),
                     [](unsigned char left, unsigned char right) {
                       return std::tolower(left) == std::tolower(right);
                     }) != haystack.end();
}

float distanceSquared(GraphVec2 a, GraphVec2 b) {
  const float x = a.x - b.x;
  const float y = a.y - b.y;
  return x * x + y * y;
}

GraphVec2 lerp(GraphVec2 a, GraphVec2 b, float amount) {
  return {a.x + (b.x - a.x) * amount, a.y + (b.y - a.y) * amount};
}

float scalarNumber(const JsonScalar& value, float fallback) {
  if (const auto* number = std::get_if<double>(&value); number != nullptr && std::isfinite(*number)) {
    return static_cast<float>(*number);
  }
  return fallback;
}

std::optional<std::string> scalarString(const std::map<std::string, JsonScalar>& meta,
                                        std::string_view key) {
  const auto found = meta.find(std::string(key));
  if (found == meta.end()) {
    return std::nullopt;
  }
  if (const auto* text = std::get_if<std::string>(&found->second)) {
    return *text;
  }
  return std::nullopt;
}

std::int64_t scalarInteger(const std::map<std::string, JsonScalar>& meta,
                           std::string_view key, std::int64_t fallback = 0) {
  const auto found = meta.find(std::string(key));
  if (found == meta.end()) {
    return fallback;
  }
  if (const auto* number = std::get_if<double>(&found->second);
      number != nullptr && std::isfinite(*number)) {
    return static_cast<std::int64_t>(*number);
  }
  return fallback;
}

ImVec4 nodeColor(std::string_view kind) {
  const ui::Palette& colors = ui::palette();
  switch (hashText(kind) % 6U) {
    case 0:
      return colors.graphNeutral;
    case 1:
      return colors.graphAccent;
    case 2:
      return colors.graphOk;
    case 3:
      return colors.graphWarn;
    case 4:
      return colors.graphErr;
    default:
      return colors.graphInfo;
  }
}

}  // namespace

struct GraphView::VisualNode {
  GraphNode data;
  std::optional<SourceLocation> source;
  bool leaving = false;
  bool changed = false;
  float changedRemaining = 0.0F;
  bool laneAnimating = false;
  std::int64_t laneRevision = 0;
  GraphVec2 laneStart{};
  GraphVec2 laneTarget{};
};

struct GraphView::VisualEdge {
  GraphEdge data;
  bool leaving = false;
};

struct GraphView::Scene {
  explicit Scene(const ForceGraphConfig& config) : solver(config) {}

  ForceGraph solver;
  std::int64_t revision = -1;
  std::map<std::string, VisualNode, std::less<>> nodes;
  std::map<std::string, VisualEdge, std::less<>> edges;
  std::map<std::string, GraphVec2, std::less<>> gitTargets;
};

GraphView::GraphView(ForceGraphConfig config)
    : scenes_(new Scene[3]{Scene(config), Scene(config), Scene(config)}) {}

GraphView::~GraphView() {
  for (GraphKind kind : {GraphKind::Code, GraphKind::Git, GraphKind::Agent}) {
    Scene& value = scene(kind);
    for (const auto& [id, node] : value.nodes) {
      (void)node;
      forgetAnimation(kind, id, false);
    }
    for (const auto& [id, edge] : value.edges) {
      (void)edge;
      forgetAnimation(kind, id, true);
    }
  }
  if (cameraTarget_.has_value()) {
    anim::forget(animationId(GraphKind::Code, std::to_string(cameraTarget_->serial), "camera"));
  }
  delete[] scenes_;
}

void GraphView::setWorkspace(std::string workspaceId) {
  if (workspaceId_ == workspaceId) {
    return;
  }
  if (cameraTarget_.has_value()) {
    anim::forget(animationId(GraphKind::Code, std::to_string(cameraTarget_->serial), "camera"));
  }
  workspaceId_ = std::move(workspaceId);
  for (GraphKind graphKind : {GraphKind::Code, GraphKind::Git, GraphKind::Agent}) {
    Scene& value = scene(graphKind);
    for (const auto& [id, node] : value.nodes) {
      (void)node;
      forgetAnimation(graphKind, id, false);
    }
    for (const auto& [id, edge] : value.edges) {
      (void)edge;
      forgetAnimation(graphKind, id, true);
    }
    value.solver.clear();
    value.nodes.clear();
    value.edges.clear();
    value.gitTargets.clear();
    value.revision = -1;
  }
  selection_.reset();
  dragging_.reset();
  scopeRoot_.reset();
  scopedIds_.clear();
  camera_ = {};
  camera_.zoom = 1.0F;
  cameraTarget_.reset();
}

const std::string& GraphView::workspace() const noexcept { return workspaceId_; }

void GraphView::setKind(GraphKind kind) {
  if (kind_ == kind) {
    return;
  }
  kind_ = kind;
  dragging_.reset();
  rebuildScope();
}

GraphKind GraphView::kind() const noexcept { return kind_; }

void GraphView::update(GraphKind graphKind, const GraphSnapshot& snapshot) {
  Scene& value = scene(graphKind);
  if (snapshot.revision < value.revision) {
    return;
  }

  std::set<std::string> incomingNodes;
  std::vector<const GraphNode*> sortedNodes;
  sortedNodes.reserve(snapshot.nodes.size());
  for (const GraphNode& node : snapshot.nodes) {
    if (!node.id.empty()) {
      sortedNodes.push_back(&node);
    }
  }
  std::stable_sort(sortedNodes.begin(), sortedNodes.end(),
                   [](const GraphNode* a, const GraphNode* b) { return a->id < b->id; });

  for (const GraphNode* input : sortedNodes) {
    if (!incomingNodes.insert(input->id).second) {
      continue;
    }
    auto found = value.nodes.find(input->id);
    const bool inserted = found == value.nodes.end();
    if (inserted) {
      VisualNode visual;
      visual.data = *input;
      visual.source = sourceFrom(*input);
      visual.leaving = input->state == GraphState::Leaving;
      visual.changed = input->state == GraphState::Changing;
      visual.changedRemaining = visual.changed ? anim::kBreathe : 0.0F;
      found = value.nodes.emplace(input->id, std::move(visual)).first;
      initializeAnimation(graphKind, input->id, false);
    } else {
      found->second.data = *input;
      found->second.source = sourceFrom(*input);
      found->second.leaving = input->state == GraphState::Leaving;
      if (input->state == GraphState::Changing) {
        found->second.changed = true;
        found->second.changedRemaining = anim::kBreathe;
      }
    }
  }

  for (auto& [id, node] : value.nodes) {
    if (!incomingNodes.contains(id)) {
      node.leaving = true;
    }
  }

  std::set<std::string> incomingEdges;
  std::vector<const GraphEdge*> sortedEdges;
  sortedEdges.reserve(snapshot.edges.size());
  for (const GraphEdge& edge : snapshot.edges) {
    if (!edge.id.empty()) {
      sortedEdges.push_back(&edge);
    }
  }
  std::stable_sort(sortedEdges.begin(), sortedEdges.end(),
                   [](const GraphEdge* a, const GraphEdge* b) { return a->id < b->id; });
  for (const GraphEdge* input : sortedEdges) {
    if (!incomingEdges.insert(input->id).second) {
      continue;
    }
    auto found = value.edges.find(input->id);
    if (found == value.edges.end()) {
      VisualEdge visual;
      visual.data = *input;
      visual.leaving = input->state == GraphState::Leaving;
      value.edges.emplace(input->id, std::move(visual));
      initializeAnimation(graphKind, input->id, true);
    } else {
      found->second.data = *input;
      found->second.leaving = input->state == GraphState::Leaving;
    }
  }
  for (auto& [id, edge] : value.edges) {
    if (!incomingEdges.contains(id)) {
      edge.leaving = true;
    }
  }

  value.revision = snapshot.revision;
  if (graphKind == GraphKind::Git) {
    value.gitTargets = computeGitLaneLayout(snapshot);
  }
  rebuildSolver(value);

  if (graphKind == GraphKind::Git) {
    for (auto& [id, node] : value.nodes) {
      const auto target = value.gitTargets.find(id);
      ForceNodeState* forceNode = value.solver.findNode(id);
      if (target == value.gitTargets.end() || forceNode == nullptr || forceNode->pinned) {
        node.laneAnimating = false;
        continue;
      }
      node.laneStart = forceNode->position;
      node.laneTarget = target->second;
      node.laneRevision = snapshot.revision;
      node.laneAnimating = distanceSquared(node.laneStart, node.laneTarget) > 0.0001F;
      if (!node.laneAnimating) {
        value.solver.setNodePosition(id, node.laneTarget);
      }
    }
  }

  if (graphKind == kind_) {
    rebuildScope();
  }
  anim::requestFrames();
}

void GraphView::tick(float deltaSeconds) {
  Scene& value = activeScene();
  const float frameDt = anim::dt(deltaSeconds);
  bool moving = false;

  if (kind_ != GraphKind::Git) {
    value.solver.step(frameDt);
    moving = !value.solver.cooled();
  }

  std::vector<std::string> retiredNodes;
  for (auto& [id, node] : value.nodes) {
    const float alphaTarget = node.leaving ? 0.0F : 1.0F;
    const float scaleTarget = node.leaving ? 0.6F : 1.0F;
    const float alpha = anim::toward(animationId(kind_, id, "node-alpha"), alphaTarget,
                                     node.leaving ? anim::kBase : anim::kSlow);
    const float scale = anim::toward(animationId(kind_, id, "node-scale"), scaleTarget,
                                     node.leaving ? anim::kBase : anim::kSlow);
    moving = moving || std::abs(alpha - alphaTarget) > kAnimationEpsilon ||
             std::abs(scale - scaleTarget) > kAnimationEpsilon;
    if (node.changedRemaining > 0.0F) {
      node.changedRemaining = std::max(0.0F, node.changedRemaining - frameDt);
      node.changed = node.changedRemaining > 0.0F;
      moving = moving || node.changed;
    }

    if (kind_ == GraphKind::Git && node.laneAnimating) {
      const std::string channel = "lane-" + std::to_string(node.laneRevision);
      const float progress = anim::toward(animationId(kind_, id, channel), 1.0F, anim::kBase);
      const float eased = anim::easeSpring(progress);
      value.solver.setNodePosition(id, lerp(node.laneStart, node.laneTarget, eased));
      node.laneAnimating = progress < 1.0F - kAnimationEpsilon;
      moving = moving || node.laneAnimating;
      if (!node.laneAnimating) {
        value.solver.setNodePosition(id, node.laneTarget);
        anim::forget(animationId(kind_, id, channel));
      }
    }

    if (node.leaving && alpha <= kAnimationEpsilon) {
      retiredNodes.push_back(id);
    }
  }

  std::vector<std::string> retiredEdges;
  for (const auto& [id, edge] : value.edges) {
    const float target = edge.leaving ? 0.0F : 1.0F;
    const float alpha = anim::toward(animationId(kind_, id, "edge-alpha"), target, anim::kBase);
    moving = moving || std::abs(alpha - target) > kAnimationEpsilon;
    if (edge.leaving && alpha <= kAnimationEpsilon) {
      retiredEdges.push_back(id);
    }
  }

  for (const std::string& id : retiredEdges) {
    forgetAnimation(kind_, id, true);
    value.edges.erase(id);
  }
  for (const std::string& id : retiredNodes) {
    forgetAnimation(kind_, id, false);
    value.nodes.erase(id);
    if (selection_ == id) {
      selection_.reset();
    }
  }
  if (!retiredNodes.empty() || !retiredEdges.empty()) {
    rebuildSolver(value);
    rebuildScope();
  }

  if (cameraTarget_.has_value()) {
    const std::string serial = std::to_string(cameraTarget_->serial);
    const ImGuiID id = animationId(GraphKind::Code, serial, "camera");
    const float progress = anim::toward(id, 1.0F, cameraDuration_);
    const float eased = anim::easeInOut(progress);
    camera_.center = lerp(cameraStart_.center, cameraTarget_->camera.center, eased);
    camera_.zoom = cameraStart_.zoom +
                   (cameraTarget_->camera.zoom - cameraStart_.zoom) * eased;
    moving = true;
    if (progress >= 1.0F - kAnimationEpsilon) {
      camera_ = cameraTarget_->camera;
      anim::forget(id);
      cameraTarget_.reset();
    }
  }

  if (moving) {
    anim::requestFrames();
  }
}

const ForceGraph& GraphView::solver(GraphKind graphKind) const { return scene(graphKind).solver; }
ForceGraph& GraphView::solver(GraphKind graphKind) { return scene(graphKind).solver; }

std::optional<GraphNodeVisualState> GraphView::nodeVisual(std::string_view id) const {
  const Scene& value = activeScene();
  const auto found = value.nodes.find(id);
  if (found == value.nodes.end()) {
    return std::nullopt;
  }
  return GraphNodeVisualState{
      anim::peek(animationId(kind_, id, "node-alpha"), found->second.leaving ? 0.0F : 1.0F),
      anim::peek(animationId(kind_, id, "node-scale"), found->second.leaving ? 0.6F : 1.0F),
      found->second.leaving, found->second.changed};
}

void GraphView::setSearch(std::string query) { search_ = std::move(query); }
const std::string& GraphView::search() const noexcept { return search_; }

std::vector<std::string> GraphView::searchMatches() const {
  std::vector<std::string> result;
  for (const auto& [id, node] : activeScene().nodes) {
    const std::string group = node.data.group.value_or(std::string{});
    if (!node.leaving && visible(id) &&
        (containsInsensitive(id, search_) || containsInsensitive(node.data.label, search_) ||
         containsInsensitive(node.data.kind, search_) || containsInsensitive(group, search_))) {
      result.push_back(id);
    }
  }
  return result;
}

void GraphView::setFilter(GraphFilter filter) {
  filter_ = std::move(filter);
  if (selection_.has_value() && !visible(*selection_)) {
    selection_.reset();
  }
}

const GraphFilter& GraphView::filter() const noexcept { return filter_; }

void GraphView::setScope(std::optional<std::string> rootId, int hops) {
  scopeRoot_ = std::move(rootId);
  scopeHops_ = std::clamp(hops, 0, 64);
  rebuildScope();
  if (selection_.has_value() && !visible(*selection_)) {
    selection_.reset();
  }
}

bool GraphView::visible(std::string_view nodeId) const {
  const Scene& value = activeScene();
  const auto found = value.nodes.find(nodeId);
  if (found == value.nodes.end()) {
    return false;
  }
  const VisualNode& node = found->second;
  if ((node.leaving && !filter_.showLeaving) ||
      (node.data.state == GraphState::Entering && !filter_.showEntering)) {
    return false;
  }
  if (!filter_.nodeKinds.empty() && !filter_.nodeKinds.contains(node.data.kind)) {
    return false;
  }
  const std::string group = node.data.group.value_or(std::string{});
  if (!filter_.groups.empty() && !filter_.groups.contains(group)) {
    return false;
  }
  return !scopeRoot_.has_value() || scopedIds_.contains(nodeId);
}

const std::optional<std::string>& GraphView::selection() const noexcept { return selection_; }

bool GraphView::select(std::string_view nodeId) {
  if (!visible(nodeId)) {
    return false;
  }
  selection_ = std::string(nodeId);
  return true;
}

void GraphView::clearSelection() { selection_.reset(); }

bool GraphView::openSource(std::string_view nodeId) {
  const auto found = activeScene().nodes.find(nodeId);
  if (found == activeScene().nodes.end() || !found->second.source.has_value()) {
    return false;
  }
  if (openSourceCallback_) {
    openSourceCallback_(*found->second.source);
  }
  return true;
}

void GraphView::setOpenSourceCallback(OpenSourceCallback callback) {
  openSourceCallback_ = std::move(callback);
}

void GraphView::pan(GraphVec2 screenDelta) {
  if (cameraTarget_.has_value()) {
    anim::forget(animationId(GraphKind::Code, std::to_string(cameraTarget_->serial), "camera"));
    cameraTarget_.reset();
  }
  camera_.center.x -= screenDelta.x / camera_.zoom;
  camera_.center.y -= screenDelta.y / camera_.zoom;
}

void GraphView::zoomAt(float factor, GraphVec2 screenPoint, ImVec2 viewportSize) {
  if (!std::isfinite(factor) || factor <= 0.0F) {
    return;
  }
  if (cameraTarget_.has_value()) {
    anim::forget(animationId(GraphKind::Code, std::to_string(cameraTarget_->serial), "camera"));
    cameraTarget_.reset();
  }
  const GraphVec2 before = screenToWorld(screenPoint, viewportSize);
  camera_.zoom = std::clamp(camera_.zoom * factor, kMinZoom, kMaxZoom);
  const GraphVec2 after = screenToWorld(screenPoint, viewportSize);
  camera_.center.x += before.x - after.x;
  camera_.center.y += before.y - after.y;
}

void GraphView::requestCamera(GraphCamera camera, GraphCameraReason reason, bool animated) {
  if (!std::isfinite(camera.center.x) || !std::isfinite(camera.center.y) ||
      !std::isfinite(camera.zoom)) {
    return;
  }
  camera.zoom = std::clamp(camera.zoom, kMinZoom, kMaxZoom);
  if (cameraTarget_.has_value()) {
    anim::forget(animationId(GraphKind::Code, std::to_string(cameraTarget_->serial), "camera"));
  }
  cameraStart_ = camera_;
  cameraDuration_ = animated ? anim::kSlow : 0.0F;
  cameraTarget_ = GraphCameraTarget{camera, reason, ++cameraSerial_};
  if (!animated) {
    camera_ = camera;
    cameraTarget_.reset();
  } else {
    anim::requestFrames();
  }
}

bool GraphView::fit(ImVec2 viewportSize, bool animated) {
  const Scene& value = activeScene();
  bool foundAny = false;
  GraphVec2 minimum{std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
  GraphVec2 maximum{std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
  for (const ForceNodeState& node : value.solver.nodes()) {
    if (!visible(node.id)) {
      continue;
    }
    foundAny = true;
    minimum.x = std::min(minimum.x, node.position.x - node.radius);
    minimum.y = std::min(minimum.y, node.position.y - node.radius);
    maximum.x = std::max(maximum.x, node.position.x + node.radius);
    maximum.y = std::max(maximum.y, node.position.y + node.radius);
  }
  if (!foundAny || viewportSize.x <= 1.0F || viewportSize.y <= 1.0F) {
    return false;
  }
  const float width = std::max(maximum.x - minimum.x, 1.0F);
  const float height = std::max(maximum.y - minimum.y, 1.0F);
  const float availableWidth = std::max(viewportSize.x - ui::metrics::px(64.0F), 1.0F);
  const float availableHeight = std::max(viewportSize.y - ui::metrics::px(64.0F), 1.0F);
  GraphCamera target;
  target.center = {(minimum.x + maximum.x) * 0.5F, (minimum.y + maximum.y) * 0.5F};
  target.zoom = std::clamp(std::min(availableWidth / width, availableHeight / height),
                           kMinZoom, kMaxZoom);
  requestCamera(target, GraphCameraReason::Fit, animated);
  return true;
}

bool GraphView::focus(std::string_view nodeId, ImVec2 viewportSize,
                      GraphCameraReason reason, bool animated) {
  (void)viewportSize;
  const ForceNodeState* node = activeScene().solver.findNode(nodeId);
  if (node == nullptr || !visible(nodeId)) {
    return false;
  }
  GraphCamera target = camera_;
  target.center = node->position;
  target.zoom = std::max(target.zoom, 1.0F);
  requestCamera(target, reason, animated);
  return true;
}

bool GraphView::focusFirstSearchResult(ImVec2 viewportSize, bool animated) {
  const std::vector<std::string> matches = searchMatches();
  return !matches.empty() && focus(matches.front(), viewportSize, GraphCameraReason::Search, animated);
}

const GraphCamera& GraphView::camera() const noexcept { return camera_; }
const std::optional<GraphCameraTarget>& GraphView::cameraTarget() const noexcept {
  return cameraTarget_;
}

GraphVec2 GraphView::worldToScreen(GraphVec2 world, ImVec2 viewportSize) const {
  return {(world.x - camera_.center.x) * camera_.zoom + viewportSize.x * 0.5F,
          (world.y - camera_.center.y) * camera_.zoom + viewportSize.y * 0.5F};
}

GraphVec2 GraphView::screenToWorld(GraphVec2 screen, ImVec2 viewportSize) const {
  return {(screen.x - viewportSize.x * 0.5F) / camera_.zoom + camera_.center.x,
          (screen.y - viewportSize.y * 0.5F) / camera_.zoom + camera_.center.y};
}

std::optional<std::string> GraphView::hitTest(GraphVec2 screen, ImVec2 viewportSize) const {
  const Scene& value = activeScene();
  std::optional<std::string> result;
  float closest = std::numeric_limits<float>::max();
  for (const ForceNodeState& node : value.solver.nodes()) {
    if (!visible(node.id)) {
      continue;
    }
    const GraphVec2 center = worldToScreen(node.position, viewportSize);
    const auto visual = nodeVisual(node.id);
    const float scale = visual.has_value() ? visual->scale : 1.0F;
    const float radius = std::max(node.radius * camera_.zoom * scale, ui::metrics::px(6.0F));
    const float squared = distanceSquared(screen, center);
    if (squared <= radius * radius && squared < closest) {
      closest = squared;
      result = node.id;
    }
  }
  return result;
}

bool GraphView::clickAt(GraphVec2 screen, ImVec2 viewportSize, bool openOnActivation) {
  const std::optional<std::string> hit = hitTest(screen, viewportSize);
  if (!hit.has_value()) {
    clearSelection();
    return false;
  }
  select(*hit);
  if (openOnActivation) {
    openSource(*hit);
  }
  return true;
}

bool GraphView::beginDrag(GraphVec2 screen, ImVec2 viewportSize) {
  const std::optional<std::string> hit = hitTest(screen, viewportSize);
  if (!hit.has_value()) {
    return false;
  }
  ForceNodeState* node = activeScene().solver.findNode(*hit);
  if (node == nullptr) {
    return false;
  }
  dragging_ = *hit;
  dragWasPinned_ = node->pinned;
  dragOffset_ = {node->position.x - screenToWorld(screen, viewportSize).x,
                 node->position.y - screenToWorld(screen, viewportSize).y};
  node->pinned = true;
  node->velocity = {};
  select(*hit);
  return true;
}

bool GraphView::dragTo(GraphVec2 screen, ImVec2 viewportSize) {
  if (!dragging_.has_value()) {
    return false;
  }
  GraphVec2 world = screenToWorld(screen, viewportSize);
  world.x += dragOffset_.x;
  world.y += dragOffset_.y;
  return activeScene().solver.setNodePosition(*dragging_, world);
}

bool GraphView::endDrag(bool pinNode) {
  if (!dragging_.has_value()) {
    return false;
  }
  activeScene().solver.setPinned(*dragging_, pinNode || dragWasPinned_);
  dragging_.reset();
  return true;
}

bool GraphView::setPinned(std::string_view nodeId, bool pinned) {
  return activeScene().solver.setPinned(nodeId, pinned);
}

std::vector<GraphAccessibleItem> GraphView::accessibleItems() const {
  std::vector<GraphAccessibleItem> items;
  for (const auto& [id, node] : activeScene().nodes) {
    if (!visible(id) || node.leaving) {
      continue;
    }
    const ForceNodeState* forceNode = activeScene().solver.findNode(id);
    items.push_back({id, node.data.label, node.data.kind, node.data.group.value_or(std::string{}),
                     selection_ == id, forceNode != nullptr && forceNode->pinned,
                     node.source.has_value()});
  }
  return items;
}

bool GraphView::performListAction(std::string_view nodeId, GraphListAction action,
                                  ImVec2 viewportSize) {
  switch (action) {
    case GraphListAction::Select:
      return select(nodeId);
    case GraphListAction::Focus:
      return select(nodeId) && focus(nodeId, viewportSize, GraphCameraReason::Selection);
    case GraphListAction::OpenSource:
      return select(nodeId) && openSource(nodeId);
    case GraphListAction::TogglePin: {
      ForceNodeState* node = activeScene().solver.findNode(nodeId);
      return node != nullptr && setPinned(nodeId, !node->pinned);
    }
  }
  return false;
}

void GraphView::setAccessibleFallback(bool enabled) { accessibleFallback_ = enabled; }
bool GraphView::accessibleFallback() const noexcept { return accessibleFallback_; }

GraphDrawResult GraphView::draw(const char* id, ImVec2 size) {
  return accessibleFallback_ ? drawAccessibleList(id, size) : drawCanvas(id, size);
}

GraphDrawResult GraphView::drawCanvas(const char* id, ImVec2 size) {
  GraphDrawResult result;
  if (size.x <= 0.0F || size.y <= 0.0F) {
    return result;
  }
  lastViewportSize_ = size;
  const ImVec2 origin = ImGui::GetCursorScreenPos();
  ImGui::InvisibleButton(id, size, ImGuiButtonFlags_MouseButtonLeft |
                                  ImGuiButtonFlags_MouseButtonMiddle);
  const bool hovered = ImGui::IsItemHovered();
  ImDrawList* drawList = ImGui::GetWindowDrawList();
  const ui::Palette& colors = ui::palette();
  drawList->AddRectFilled(origin, ImVec2(origin.x + size.x, origin.y + size.y),
                          ui::toU32(colors.panelBg));

  if (hovered && ImGui::GetIO().MouseWheel != 0.0F) {
    const ImVec2 mouse = ImGui::GetIO().MousePos;
    zoomAt(std::pow(1.12F, ImGui::GetIO().MouseWheel),
           {mouse.x - origin.x, mouse.y - origin.y}, size);
    result.cameraChanged = true;
  }
  if (hovered && ImGui::IsMouseDragging(ImGuiMouseButton_Middle)) {
    const ImVec2 delta = ImGui::GetIO().MouseDelta;
    pan({delta.x, delta.y});
    result.cameraChanged = true;
  }

  const Scene& value = activeScene();
  for (const auto& [id, edge] : value.edges) {
    const ForceNodeState* source = value.solver.findNode(edge.data.source);
    const ForceNodeState* target = value.solver.findNode(edge.data.target);
    if (source == nullptr || target == nullptr || !visible(source->id) || !visible(target->id)) {
      continue;
    }
    const float alpha = anim::peek(animationId(kind_, id, "edge-alpha"), edge.leaving ? 0.0F : 1.0F);
    const ImVec4 role = selection_ == source->id || selection_ == target->id
                            ? colors.accentOverlayBorder
                            : colors.borderStrong;
    const ImU32 color = ui::toU32(ui::withAlpha(role, role.w * alpha));
    const GraphVec2 from = worldToScreen(source->position, size);
    const GraphVec2 to = worldToScreen(target->position, size);
    drawList->AddLine(ImVec2(origin.x + from.x, origin.y + from.y),
                      ImVec2(origin.x + to.x, origin.y + to.y), color,
                      ui::metrics::stroke(selection_ == source->id || selection_ == target->id
                                              ? 2.0F
                                              : 1.0F));
  }

  for (const ForceNodeState& node : value.solver.nodes()) {
    if (!visible(node.id)) {
      continue;
    }
    const auto visualData = value.nodes.find(node.id);
    if (visualData == value.nodes.end()) {
      continue;
    }
    const VisualNode& visual = visualData->second;
    const float alpha = anim::peek(animationId(kind_, node.id, "node-alpha"),
                                   visual.leaving ? 0.0F : 1.0F);
    const float scale = anim::peek(animationId(kind_, node.id, "node-scale"),
                                   visual.leaving ? 0.6F : 1.0F);
    const GraphVec2 local = worldToScreen(node.position, size);
    const ImVec2 center(origin.x + local.x, origin.y + local.y);
    const float radius = std::max(node.radius * camera_.zoom * scale, ui::metrics::px(3.0F));
    ImVec4 fillRole = selection_ == node.id ? colors.accentSelection : nodeColor(visual.data.kind);
    fillRole = ui::withAlpha(fillRole, fillRole.w * alpha);
    if (visual.changed && alpha > 0.0F) {
      const float pulse = anim::pulse(anim::kBreathe);
      const ImVec4 halo = ui::withAlpha(colors.accentSoft, colors.accentSoft.w * pulse * alpha);
      drawList->AddCircleFilled(center, radius + ui::metrics::px(6.0F), ui::toU32(halo));
    }
    drawList->AddCircleFilled(center, radius, ui::toU32(fillRole));
    const ImVec4 borderRole = selection_ == node.id ? colors.focusRing : colors.borderStrong;
    drawList->AddCircle(center, radius, ui::toU32(ui::withAlpha(borderRole, borderRole.w * alpha)),
                        0, ui::metrics::stroke(selection_ == node.id ? 2.0F : 1.0F));

    if (camera_.zoom >= 0.55F && alpha > 0.15F && !visual.data.label.empty()) {
      const ImVec2 textSize = ImGui::CalcTextSize(visual.data.label.c_str());
      const ImVec4 textRole = ui::withAlpha(colors.text, colors.text.w * alpha);
      drawList->AddText(ImVec2(center.x - textSize.x * 0.5F, center.y + radius +
                                                                ui::metrics::px(4.0F)),
                        ui::toU32(textRole), visual.data.label.c_str());
    }
  }

  if (hovered) {
    const ImVec2 mouse = ImGui::GetIO().MousePos;
    const GraphVec2 local{mouse.x - origin.x, mouse.y - origin.y};
    if (ImGui::IsMouseClicked(ImGuiMouseButton_Left)) {
      const std::optional<std::string> before = selection_;
      clickAt(local, size, false);
      result.selectionChanged = before != selection_;
      if (ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left) && selection_.has_value()) {
        result.sourceOpened = openSource(*selection_);
      }
      beginDrag(local, size);
    }
    if (ImGui::IsMouseDragging(ImGuiMouseButton_Left) && dragging_.has_value()) {
      dragTo(local, size);
    }
    if (ImGui::IsMouseReleased(ImGuiMouseButton_Left) && dragging_.has_value()) {
      endDrag(false);
    }
  }
  return result;
}

GraphDrawResult GraphView::drawAccessibleList(const char* id, ImVec2 size) {
  GraphDrawResult result;
  lastViewportSize_ = size;
  if (!ImGui::BeginChild(id, size, ImGuiChildFlags_Borders)) {
    ImGui::EndChild();
    return result;
  }
  for (const GraphAccessibleItem& item : accessibleItems()) {
    ImGui::PushID(item.id.c_str());
    const std::optional<std::string> before = selection_;
    if (ImGui::Selectable(item.label.c_str(), item.selected,
                          ImGuiSelectableFlags_AllowDoubleClick)) {
      select(item.id);
      result.selectionChanged = before != selection_;
      if (ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
        result.sourceOpened = openSource(item.id);
      }
    }
    ImGui::SameLine();
    if (ImGui::SmallButton(item.pinned ? "Unpin" : "Pin")) {
      performListAction(item.id, GraphListAction::TogglePin, size);
    }
    if (item.hasSource) {
      ImGui::SameLine();
      if (ImGui::SmallButton("Open")) {
        result.sourceOpened = performListAction(item.id, GraphListAction::OpenSource, size);
      }
    }
    ImGui::PopID();
  }
  ImGui::EndChild();
  return result;
}

std::string GraphView::exportCache(std::string_view workspaceId, GraphKind graphKind) const {
  const Scene& value = scene(graphKind);
  nlohmann::json payload = {
      {"schema", kCacheSchemaVersion},
      {"workspace", std::string(workspaceId)},
      {"kind", std::string(kindName(graphKind))},
      {"revision", value.revision},
      {"camera", {{"x", camera_.center.x}, {"y", camera_.center.y}, {"zoom", camera_.zoom}}},
      {"nodes", nlohmann::json::array()},
  };
  for (const ForceNodeState& node : value.solver.nodes()) {
    payload["nodes"].push_back(
        {{"id", node.id}, {"x", node.position.x}, {"y", node.position.y}, {"pinned", node.pinned}});
  }
  return payload.dump();
}

bool GraphView::importCache(std::string_view payloadText, std::string_view workspaceId,
                            GraphKind graphKind) {
  const nlohmann::json payload = nlohmann::json::parse(payloadText, nullptr, false);
  if (payload.is_discarded() || !payload.is_object() ||
      payload.value("schema", -1) != kCacheSchemaVersion ||
      payload.value("workspace", std::string{}) != workspaceId ||
      payload.value("kind", std::string{}) != kindName(graphKind) ||
      !payload.contains("nodes") || !payload["nodes"].is_array() ||
      payload["nodes"].size() > 100000U) {
    return false;
  }

  Scene& value = scene(graphKind);
  for (const nlohmann::json& item : payload["nodes"]) {
    if (!item.is_object() || !item.contains("id") || !item["id"].is_string()) {
      continue;
    }
    const float x = item.value("x", std::numeric_limits<float>::quiet_NaN());
    const float y = item.value("y", std::numeric_limits<float>::quiet_NaN());
    if (!std::isfinite(x) || !std::isfinite(y)) {
      continue;
    }
    const std::string id = item["id"].get<std::string>();
    value.solver.setNodePosition(id, {x, y});
    value.solver.setPinned(id, item.value("pinned", false));
  }

  if (payload.contains("camera") && payload["camera"].is_object()) {
    const nlohmann::json& stored = payload["camera"];
    GraphCamera restored;
    restored.center.x = stored.value("x", 0.0F);
    restored.center.y = stored.value("y", 0.0F);
    restored.zoom = stored.value("zoom", 1.0F);
    requestCamera(restored, GraphCameraReason::Restore, false);
  }
  return true;
}

std::string GraphView::cacheKey(std::string_view workspaceId, GraphKind graphKind) {
  return std::string(workspaceId) + "/graph/" + std::string(kindName(graphKind)) +
         "/v" + std::to_string(kCacheSchemaVersion);
}

std::map<std::string, GraphVec2, std::less<>> GraphView::computeGitLaneLayout(
    const GraphSnapshot& snapshot, float columnSpacing, float laneSpacing) {
  columnSpacing = std::max(columnSpacing, 1.0F);
  laneSpacing = std::max(laneSpacing, 1.0F);
  std::map<std::string, std::vector<std::string>> lanes;
  for (const GraphNode& node : snapshot.nodes) {
    if (!node.id.empty()) {
      lanes[node.group.value_or(std::string{})].push_back(node.id);
    }
  }
  for (auto& [group, ids] : lanes) {
    (void)group;
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
  }

  std::map<std::string, GraphVec2, std::less<>> result;
  const float laneCenter = static_cast<float>(lanes.size() > 0 ? lanes.size() - 1U : 0U) * 0.5F;
  std::size_t lane = 0;
  for (const auto& [group, ids] : lanes) {
    (void)group;
    const float columnCenter = static_cast<float>(ids.size() > 0 ? ids.size() - 1U : 0U) * 0.5F;
    for (std::size_t column = 0; column < ids.size(); ++column) {
      result.emplace(ids[column],
                     GraphVec2{(static_cast<float>(column) - columnCenter) * columnSpacing,
                               (static_cast<float>(lane) - laneCenter) * laneSpacing});
    }
    ++lane;
  }
  return result;
}

std::optional<GraphVec2> GraphView::gitLaneTarget(std::string_view nodeId) const {
  const Scene& value = scene(GraphKind::Git);
  const auto found = value.gitTargets.find(nodeId);
  return found == value.gitTargets.end() ? std::nullopt : std::optional(found->second);
}

GraphView::Scene& GraphView::activeScene() { return scene(kind_); }
const GraphView::Scene& GraphView::activeScene() const { return scene(kind_); }
GraphView::Scene& GraphView::scene(GraphKind graphKind) { return scenes_[sceneIndex(graphKind)]; }
const GraphView::Scene& GraphView::scene(GraphKind graphKind) const {
  return scenes_[sceneIndex(graphKind)];
}

void GraphView::rebuildSolver(Scene& value) {
  std::vector<ForceNodeInput> nodes;
  nodes.reserve(value.nodes.size());
  for (const auto& [id, visual] : value.nodes) {
    const ForceNodeState* existing = value.solver.findNode(id);
    float radius = (&value == &scene(GraphKind::Git)) ? kGitNodeRadius : kNodeRadius;
    const auto radiusMeta = visual.data.meta.find("radius");
    if (radiusMeta != visual.data.meta.end()) {
      radius = scalarNumber(radiusMeta->second, radius);
    }
    bool pinned = existing != nullptr && existing->pinned;
    const auto pinnedMeta = visual.data.meta.find("pinned");
    if (pinnedMeta != visual.data.meta.end()) {
      if (const auto* stored = std::get_if<bool>(&pinnedMeta->second)) {
        pinned = *stored;
      }
    }
    std::optional<GraphVec2> initial;
    if (existing != nullptr) {
      initial = existing->position;
    } else if (const auto lane = value.gitTargets.find(id); lane != value.gitTargets.end()) {
      initial = lane->second;
    }
    nodes.push_back({id, radius, pinned, initial});
  }

  std::vector<ForceEdgeInput> edges;
  edges.reserve(value.edges.size());
  for (const auto& [id, visual] : value.edges) {
    edges.push_back({id, visual.data.source, visual.data.target, 96.0F, 1.0F});
  }
  value.solver.update(nodes, edges);
}

void GraphView::rebuildScope() {
  scopedIds_.clear();
  if (!scopeRoot_.has_value()) {
    return;
  }
  const Scene& value = activeScene();
  if (!value.nodes.contains(*scopeRoot_)) {
    return;
  }
  std::map<std::string, std::vector<std::string>> adjacency;
  for (const auto& [id, edge] : value.edges) {
    (void)id;
    if (!edge.leaving) {
      adjacency[edge.data.source].push_back(edge.data.target);
      adjacency[edge.data.target].push_back(edge.data.source);
    }
  }
  std::queue<std::pair<std::string, int>> pending;
  pending.emplace(*scopeRoot_, 0);
  scopedIds_.insert(*scopeRoot_);
  while (!pending.empty()) {
    auto [id, depth] = pending.front();
    pending.pop();
    if (depth >= scopeHops_) {
      continue;
    }
    auto neighbors = adjacency.find(id);
    if (neighbors == adjacency.end()) {
      continue;
    }
    std::sort(neighbors->second.begin(), neighbors->second.end());
    for (const std::string& neighbor : neighbors->second) {
      if (scopedIds_.insert(neighbor).second) {
        pending.emplace(neighbor, depth + 1);
      }
    }
  }
}

void GraphView::initializeAnimation(GraphKind graphKind, std::string_view id, bool edge) {
  if (edge) {
    (void)anim::toward(animationId(graphKind, id, "edge-alpha"), 0.0F, anim::kInstant);
    return;
  }
  (void)anim::toward(animationId(graphKind, id, "node-alpha"), 0.0F, anim::kInstant);
  (void)anim::toward(animationId(graphKind, id, "node-scale"), 0.0F, anim::kInstant);
}

void GraphView::forgetAnimation(GraphKind graphKind, std::string_view id, bool edge) {
  if (edge) {
    anim::forget(animationId(graphKind, id, "edge-alpha"));
    return;
  }
  anim::forget(animationId(graphKind, id, "node-alpha"));
  anim::forget(animationId(graphKind, id, "node-scale"));
}

ImGuiID GraphView::animationId(GraphKind graphKind, std::string_view id,
                               std::string_view channel) const {
  std::uint32_t hash = hashText(kindName(graphKind));
  hash = hashText(id, hash);
  hash = hashText(channel, hash);
  const auto address = reinterpret_cast<std::uintptr_t>(this);
  hash ^= static_cast<std::uint32_t>(address);
  hash ^= static_cast<std::uint32_t>(address >> 32U);
  return hash == 0U ? 1U : hash;
}

std::optional<SourceLocation> GraphView::sourceFrom(const GraphNode& node) {
  std::optional<std::string> uri = scalarString(node.meta, "uri");
  if (!uri.has_value()) {
    uri = scalarString(node.meta, "path");
  }
  if (!uri.has_value()) {
    uri = scalarString(node.meta, "source");
  }
  if (!uri.has_value() || uri->empty()) {
    return std::nullopt;
  }
  return SourceLocation{*uri,
                        scalarInteger(node.meta, "line",
                                      scalarInteger(node.meta, "sourceLine")),
                        scalarInteger(node.meta, "column",
                                      scalarInteger(node.meta, "sourceColumn"))};
}

}  // namespace chud
