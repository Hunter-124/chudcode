#include "graph/force_graph.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <unordered_set>
#include <utility>

namespace chud {
namespace {

constexpr float kEpsilon = 1.0e-5F;

GraphVec2 add(GraphVec2 a, GraphVec2 b) { return {a.x + b.x, a.y + b.y}; }
GraphVec2 subtract(GraphVec2 a, GraphVec2 b) { return {a.x - b.x, a.y - b.y}; }
GraphVec2 multiply(GraphVec2 value, float scalar) { return {value.x * scalar, value.y * scalar}; }
float lengthSquared(GraphVec2 value) { return value.x * value.x + value.y * value.y; }

std::uint64_t mix64(std::uint64_t value) {
  value += 0x9E3779B97F4A7C15ULL;
  value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
  value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
  return value ^ (value >> 31U);
}

std::uint64_t stableHash(std::string_view text, std::uint64_t seed) {
  std::uint64_t hash = 1469598103934665603ULL ^ seed;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return mix64(hash);
}

GraphVec2 deterministicDirection(std::string_view first, std::string_view second,
                                 std::uint64_t seed) {
  std::uint64_t hash = stableHash(first, seed);
  hash = stableHash(second, hash);
  const float x = static_cast<float>(static_cast<std::int32_t>(hash & 0xFFFFU) - 32767) / 32767.0F;
  const float y = static_cast<float>(static_cast<std::int32_t>((hash >> 16U) & 0xFFFFU) - 32767) / 32767.0F;
  const float magnitude = std::sqrt(x * x + y * y);
  if (magnitude > kEpsilon) {
    return {x / magnitude, y / magnitude};
  }
  return {1.0F, 0.0F};
}

struct Cell {
  int x = 0;
  int y = 0;

  friend bool operator==(const Cell&, const Cell&) = default;
};

struct CellHash {
  std::size_t operator()(Cell cell) const noexcept {
    const auto x = static_cast<std::uint64_t>(static_cast<std::uint32_t>(cell.x));
    const auto y = static_cast<std::uint64_t>(static_cast<std::uint32_t>(cell.y));
    return static_cast<std::size_t>(mix64((x << 32U) | y));
  }
};

using SpatialGrid = std::unordered_map<Cell, std::vector<std::size_t>, CellHash>;

Cell cellFor(GraphVec2 position, float cellSize) {
  return {static_cast<int>(std::floor(position.x / cellSize)),
          static_cast<int>(std::floor(position.y / cellSize))};
}

SpatialGrid buildGrid(const std::vector<ForceNodeState>& nodes, float cellSize) {
  SpatialGrid grid;
  grid.reserve(nodes.size() * 2U + 1U);
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    grid[cellFor(nodes[index].position, cellSize)].push_back(index);
  }
  return grid;
}

bool finite(GraphVec2 value) { return std::isfinite(value.x) && std::isfinite(value.y); }

}  // namespace

ForceGraph::ForceGraph(ForceGraphConfig config) : config_(config) {
  if (!finite(config_.worldMin) || !finite(config_.worldMax) ||
      config_.worldMin.x >= config_.worldMax.x || config_.worldMin.y >= config_.worldMax.y) {
    config_.worldMin = {-8192.0F, -8192.0F};
    config_.worldMax = {8192.0F, 8192.0F};
  }
  config_.minNodeRadius = std::max(0.5F, config_.minNodeRadius);
  config_.maxNodeRadius = std::max(config_.minNodeRadius, config_.maxNodeRadius);
  config_.minSpringLength = std::max(1.0F, config_.minSpringLength);
  config_.maxSpringLength = std::max(config_.minSpringLength, config_.maxSpringLength);
  config_.repulsionRadius = std::max(1.0F, config_.repulsionRadius);
  config_.spatialCellSize = std::max(4.0F, config_.spatialCellSize);
  config_.collisionIterations = std::clamp(config_.collisionIterations, 1, 8);
  config_.dampingPerSixtieth = std::clamp(config_.dampingPerSixtieth, 0.0F, 1.0F);
  config_.maxSpeed = std::max(1.0F, config_.maxSpeed);
  config_.maxStepSeconds = std::clamp(config_.maxStepSeconds, 0.001F, 0.1F);
  config_.coolingRate = std::max(0.0F, config_.coolingRate);
  config_.minimumTemperature = std::clamp(config_.minimumTemperature, 0.0F, 1.0F);
}
std::size_t GraphStringHash::operator()(std::string_view value) const noexcept {
  return std::hash<std::string_view>{}(value);
}


void ForceGraph::update(const std::vector<ForceNodeInput>& inputs,
                        const std::vector<ForceEdgeInput>& edgeInputs) {
  std::vector<ForceNodeInput> canonicalNodes = inputs;
  std::stable_sort(canonicalNodes.begin(), canonicalNodes.end(),
                   [](const ForceNodeInput& a, const ForceNodeInput& b) { return a.id < b.id; });

  std::vector<ForceNodeState> nextNodes;
  nextNodes.reserve(canonicalNodes.size());
  std::string previousId;
  bool changed = false;
  for (const ForceNodeInput& input : canonicalNodes) {
    if (input.id.empty() || input.id == previousId) {
      continue;
    }
    previousId = input.id;
    const float radius = std::clamp(input.radius, config_.minNodeRadius, config_.maxNodeRadius);
    const auto existing = nodeIndex_.find(input.id);
    if (existing != nodeIndex_.end()) {
      ForceNodeState node = nodes_[existing->second];
      changed = changed || node.radius != radius || node.pinned != input.pinned;
      node.radius = radius;
      node.pinned = input.pinned;
      if (node.pinned) {
        node.velocity = {};
      }
      node.position = boundedPosition(node.position, node.radius);
      nextNodes.push_back(std::move(node));
    } else {
      GraphVec2 position = input.initialPosition.value_or(seededPosition(input.id));
      if (!finite(position)) {
        position = seededPosition(input.id);
      }
      nextNodes.push_back({input.id, boundedPosition(position, radius), {}, radius, input.pinned});
      changed = true;
    }
  }
  changed = changed || nextNodes.size() != nodes_.size();
  nodes_ = std::move(nextNodes);
  rebuildIndex();

  std::vector<ForceEdgeInput> canonicalEdges = edgeInputs;
  std::stable_sort(canonicalEdges.begin(), canonicalEdges.end(),
                   [](const ForceEdgeInput& a, const ForceEdgeInput& b) { return a.id < b.id; });
  std::vector<ForceEdgeState> nextEdges;
  nextEdges.reserve(canonicalEdges.size());
  previousId.clear();
  for (const ForceEdgeInput& input : canonicalEdges) {
    if (input.id.empty() || input.id == previousId || input.source == input.target) {
      continue;
    }
    previousId = input.id;
    const auto source = nodeIndex_.find(input.source);
    const auto target = nodeIndex_.find(input.target);
    if (source == nodeIndex_.end() || target == nodeIndex_.end()) {
      continue;
    }
    const float restLength = std::clamp(input.restLength, config_.minSpringLength,
                                        config_.maxSpringLength);
    const float strength = std::max(0.0F, input.strength);
    nextEdges.push_back({input.id, input.source, input.target, source->second, target->second,
                         restLength, strength});
  }
  if (nextEdges.size() != edges_.size()) {
    changed = true;
  } else {
    for (std::size_t index = 0; index < nextEdges.size(); ++index) {
      const ForceEdgeState& a = nextEdges[index];
      const ForceEdgeState& b = edges_[index];
      if (a.id != b.id || a.source != b.source || a.target != b.target ||
          a.restLength != b.restLength || a.strength != b.strength) {
        changed = true;
        break;
      }
    }
  }
  edges_ = std::move(nextEdges);
  if (changed) {
    reheat();
  }
}

void ForceGraph::clear() {
  nodes_.clear();
  edges_.clear();
  nodeIndex_.clear();
  stats_ = {};
  temperature_ = config_.minimumTemperature;
}

void ForceGraph::step(float deltaSeconds) {
  stats_ = {};
  stats_.nodeCount = nodes_.size();
  stats_.edgeCount = edges_.size();
  if (nodes_.empty() || !std::isfinite(deltaSeconds) || deltaSeconds <= 0.0F) {
    return;
  }

  const float dt = std::min(deltaSeconds, config_.maxStepSeconds);
  const float cellSize = config_.spatialCellSize;
  const int repulsionRange = std::max(1, static_cast<int>(std::ceil(config_.repulsionRadius / cellSize)));
  SpatialGrid grid = buildGrid(nodes_, cellSize);
  stats_.spatialCells = grid.size();
  std::vector<GraphVec2> forces(nodes_.size());

  const float repulsionRadiusSquared = config_.repulsionRadius * config_.repulsionRadius;
  for (std::size_t first = 0; first < nodes_.size(); ++first) {
    const Cell origin = cellFor(nodes_[first].position, cellSize);
    for (int y = -repulsionRange; y <= repulsionRange; ++y) {
      for (int x = -repulsionRange; x <= repulsionRange; ++x) {
        const auto bucket = grid.find({origin.x + x, origin.y + y});
        if (bucket == grid.end()) {
          continue;
        }
        for (const std::size_t second : bucket->second) {
          if (second <= first) {
            continue;
          }
          ++stats_.pairChecks;
          GraphVec2 delta = subtract(nodes_[second].position, nodes_[first].position);
          float distanceSquared = lengthSquared(delta);
          if (distanceSquared > repulsionRadiusSquared) {
            continue;
          }
          if (distanceSquared < kEpsilon * kEpsilon) {
            delta = deterministicDirection(nodes_[first].id, nodes_[second].id,
                                           config_.deterministicSeed);
            distanceSquared = 1.0F;
          }
          const float distance = std::sqrt(distanceSquared);
          const GraphVec2 direction = multiply(delta, 1.0F / distance);
          const float falloff = 1.0F - std::min(distance / config_.repulsionRadius, 1.0F);
          const float magnitude = config_.repulsionStrength * falloff * falloff /
                                  std::max(distance, 8.0F);
          const GraphVec2 force = multiply(direction, magnitude * temperature_);
          forces[first] = subtract(forces[first], force);
          forces[second] = add(forces[second], force);
          ++stats_.repulsionPairs;
        }
      }
    }
  }

  for (const ForceEdgeState& edge : edges_) {
    ForceNodeState& source = nodes_[edge.sourceIndex];
    ForceNodeState& target = nodes_[edge.targetIndex];
    GraphVec2 delta = subtract(target.position, source.position);
    float distanceSquared = lengthSquared(delta);
    if (distanceSquared < kEpsilon * kEpsilon) {
      delta = deterministicDirection(source.id, target.id, config_.deterministicSeed);
      distanceSquared = 1.0F;
    }
    const float distance = std::sqrt(distanceSquared);
    const float extension = distance - edge.restLength;
    const float magnitude = extension * config_.springStrength * edge.strength * temperature_;
    const GraphVec2 force = multiply(delta, magnitude / distance);
    forces[edge.sourceIndex] = add(forces[edge.sourceIndex], force);
    forces[edge.targetIndex] = subtract(forces[edge.targetIndex], force);
    ++stats_.springsApplied;
  }

  const float damping = std::pow(config_.dampingPerSixtieth, dt * 60.0F);
  const float maxSpeedSquared = config_.maxSpeed * config_.maxSpeed;
  for (std::size_t index = 0; index < nodes_.size(); ++index) {
    ForceNodeState& node = nodes_[index];
    if (node.pinned) {
      node.velocity = {};
      continue;
    }
    forces[index] = add(forces[index],
                        multiply(node.position, -config_.centeringStrength * temperature_));
    node.velocity = multiply(add(node.velocity, multiply(forces[index], dt)), damping);
    const float speedSquared = lengthSquared(node.velocity);
    if (speedSquared > maxSpeedSquared) {
      node.velocity = multiply(node.velocity, config_.maxSpeed / std::sqrt(speedSquared));
    }
    node.position = boundedPosition(add(node.position, multiply(node.velocity, dt)), node.radius);
  }

  const float collisionReach = config_.maxNodeRadius * 2.0F + config_.collisionPadding;
  const int collisionRange = std::max(1, static_cast<int>(std::ceil(collisionReach / cellSize)));
  for (int iteration = 0; iteration < config_.collisionIterations; ++iteration) {
    grid = buildGrid(nodes_, cellSize);
    for (std::size_t first = 0; first < nodes_.size(); ++first) {
      const Cell origin = cellFor(nodes_[first].position, cellSize);
      for (int y = -collisionRange; y <= collisionRange; ++y) {
        for (int x = -collisionRange; x <= collisionRange; ++x) {
          const auto bucket = grid.find({origin.x + x, origin.y + y});
          if (bucket == grid.end()) {
            continue;
          }
          for (const std::size_t second : bucket->second) {
            if (second <= first || (nodes_[first].pinned && nodes_[second].pinned)) {
              continue;
            }
            GraphVec2 delta = subtract(nodes_[second].position, nodes_[first].position);
            float distanceSquared = lengthSquared(delta);
            const float required = nodes_[first].radius + nodes_[second].radius +
                                   config_.collisionPadding;
            if (distanceSquared >= required * required) {
              continue;
            }
            if (distanceSquared < kEpsilon * kEpsilon) {
              delta = deterministicDirection(nodes_[first].id, nodes_[second].id,
                                             config_.deterministicSeed);
              distanceSquared = 1.0F;
            }
            const float distance = std::sqrt(distanceSquared);
            const GraphVec2 direction = multiply(delta, 1.0F / distance);
            const float overlap = required - distance;
            const bool firstFree = !nodes_[first].pinned;
            const bool secondFree = !nodes_[second].pinned;
            const float firstShare = firstFree ? (secondFree ? 0.5F : 1.0F) : 0.0F;
            const float secondShare = secondFree ? (firstFree ? 0.5F : 1.0F) : 0.0F;
            nodes_[first].position = boundedPosition(
                subtract(nodes_[first].position, multiply(direction, overlap * firstShare)),
                nodes_[first].radius);
            nodes_[second].position = boundedPosition(
                add(nodes_[second].position, multiply(direction, overlap * secondShare)),
                nodes_[second].radius);
            const GraphVec2 impulse = multiply(direction, overlap * config_.collisionStrength * dt);
            if (firstFree) {
              nodes_[first].velocity = subtract(nodes_[first].velocity, multiply(impulse, firstShare));
            }
            if (secondFree) {
              nodes_[second].velocity = add(nodes_[second].velocity, multiply(impulse, secondShare));
            }
            ++stats_.collisionPairs;
          }
        }
      }
    }
  }

  temperature_ = std::max(config_.minimumTemperature,
                          temperature_ * std::exp(-config_.coolingRate * dt));
}

void ForceGraph::reheat(float temperature) {
  if (std::isfinite(temperature)) {
    temperature_ = std::clamp(temperature, config_.minimumTemperature, 1.0F);
  }
}

const ForceGraphConfig& ForceGraph::config() const noexcept { return config_; }
const std::vector<ForceNodeState>& ForceGraph::nodes() const noexcept { return nodes_; }
const std::vector<ForceEdgeState>& ForceGraph::edges() const noexcept { return edges_; }
const ForceGraphStats& ForceGraph::stats() const noexcept { return stats_; }

const ForceNodeState* ForceGraph::findNode(std::string_view id) const noexcept {
  const auto found = nodeIndex_.find(id);
  return found == nodeIndex_.end() ? nullptr : &nodes_[found->second];
}

ForceNodeState* ForceGraph::findNode(std::string_view id) noexcept {
  const auto found = nodeIndex_.find(id);
  return found == nodeIndex_.end() ? nullptr : &nodes_[found->second];
}

float ForceGraph::temperature() const noexcept { return temperature_; }
bool ForceGraph::cooled() const noexcept {
  return temperature_ <= config_.minimumTemperature + std::numeric_limits<float>::epsilon() * 8.0F;
}

bool ForceGraph::setNodePosition(std::string_view id, GraphVec2 position, bool clearVelocity) {
  ForceNodeState* node = findNode(id);
  if (node == nullptr || !finite(position)) {
    return false;
  }
  node->position = boundedPosition(position, node->radius);
  if (clearVelocity) {
    node->velocity = {};
  }
  reheat();
  return true;
}

bool ForceGraph::setPinned(std::string_view id, bool pinned) {
  ForceNodeState* node = findNode(id);
  if (node == nullptr) {
    return false;
  }
  node->pinned = pinned;
  if (pinned) {
    node->velocity = {};
  }
  reheat();
  return true;
}

void ForceGraph::rebuildIndex() {
  nodeIndex_.clear();
  nodeIndex_.reserve(nodes_.size() * 2U + 1U);
  for (std::size_t index = 0; index < nodes_.size(); ++index) {
    nodeIndex_.emplace(nodes_[index].id, index);
  }
}

GraphVec2 ForceGraph::seededPosition(std::string_view id) const {
  const std::uint64_t hash = stableHash(id, config_.deterministicSeed);
  const float unit = static_cast<float>((hash >> 11U) & 0x1FFFFFU) /
                     static_cast<float>(0x1FFFFFU);
  const float radial = static_cast<float>((hash >> 37U) & 0xFFFFU) /
                       static_cast<float>(0xFFFFU);
  const float angle = unit * 6.2831853071795864769F;
  const float radius = std::sqrt(radial) * config_.initialPlacementRadius;
  return {std::cos(angle) * radius, std::sin(angle) * radius};
}

GraphVec2 ForceGraph::boundedPosition(GraphVec2 position, float radius) const {
  const float minX = std::min(config_.worldMin.x + radius, config_.worldMax.x - radius);
  const float maxX = std::max(config_.worldMin.x + radius, config_.worldMax.x - radius);
  const float minY = std::min(config_.worldMin.y + radius, config_.worldMax.y - radius);
  const float maxY = std::max(config_.worldMin.y + radius, config_.worldMax.y - radius);
  return {std::clamp(position.x, minX, maxX), std::clamp(position.y, minY, maxY)};
}

}  // namespace chud
