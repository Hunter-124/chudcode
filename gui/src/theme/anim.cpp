#include "theme/anim.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <unordered_map>

namespace chud::anim {
namespace {

struct TweenState {
    float value = 0.0f;
    float target = 0.0f;
};

std::unordered_map<ImGuiID, TweenState> gTweens;
float gMotionScale = 1.0f;
bool gFrameRequested = false;

float clamp01(float value) { return std::clamp(value, 0.0f, 1.0f); }

double nowSeconds() {
    if (ImGui::GetCurrentContext() != nullptr) return ImGui::GetTime();
    using Clock = std::chrono::steady_clock;
    static const Clock::time_point epoch = Clock::now();
    return std::chrono::duration<double>(Clock::now() - epoch).count();
}

}  // namespace

float easeOut(float t) {
    t = clamp01(t);
    const float inv = 1.0f - t;
    return 1.0f - inv * inv * inv;
}

float easeInOut(float t) {
    t = clamp01(t);
    return t * t * (3.0f - 2.0f * t);
}

float easeOutBack(float t) {
    t = clamp01(t);
    constexpr float kOvershoot = 1.70158f;
    const float shifted = t - 1.0f;
    return 1.0f + (kOvershoot + 1.0f) * shifted * shifted * shifted +
           kOvershoot * shifted * shifted;
}

float easeSpring(float t) {
    t = clamp01(t);
    constexpr float kResponse = 6.0f;
    const auto response = [=](float value) {
        return 1.0f - (1.0f + kResponse * value) * std::exp(-kResponse * value);
    };
    // Normalizing preserves the critically damped shape while making the token
    // endpoint exact, which prevents one-pixel residue in layout motion.
    return clamp01(response(t) / response(1.0f));
}

float dt(float rawSeconds) { return std::clamp(rawSeconds, 0.0f, kMaxDeltaTime); }

float dt() {
    if (ImGui::GetCurrentContext() == nullptr) return 0.0f;
    return dt(ImGui::GetIO().DeltaTime);
}

void setMotionScale(float scale) {
    gMotionScale = std::clamp(scale, 0.0f, 4.0f);
    if (gMotionScale == 0.0f) gFrameRequested = false;
}

float motionScale() { return gMotionScale; }
void requestFrames(float seconds) {
    if (seconds > 0.0f) requestFrames();
}

void requestFrames() {
    if (gMotionScale > 0.0f) gFrameRequested = true;
}

bool consumeFrameRequest() {
    const bool requested = gFrameRequested;
    gFrameRequested = false;
    return requested;
}

float toward(ImGuiID id, float target, float seconds) {
    TweenState& state = gTweens[id];
    state.target = target;

    const float scaledDuration = std::max(0.0f, seconds) * gMotionScale;
    if (scaledDuration <= 0.0f) {
        state.value = target;
        return state.value;
    }

    const float difference = target - state.value;
    const float tolerance = 0.0001f * std::max(1.0f, std::abs(target));
    if (std::abs(difference) <= tolerance) {
        state.value = target;
        return state.value;
    }

    // ln(1000) settles to 99.9% at one nominal duration. Unlike a linear
    // elapsed timer, this remains continuous when target changes mid-flight.
    constexpr float kSettle = 6.90775527898f;
    const float step = dt();
    if (step > 0.0f) {
        const float blend = 1.0f - std::exp(-kSettle * step / scaledDuration);
        state.value += difference * blend;
    }

    if (std::abs(target - state.value) <= tolerance) {
        state.value = target;
    } else {
        requestFrames();
    }
    return state.value;
}

float peek(ImGuiID id, float fallback) {
    const auto found = gTweens.find(id);
    return found == gTweens.end() ? fallback : found->second.value;
}

void forget(ImGuiID id) { gTweens.erase(id); }
void forgetAll() { gTweens.clear(); }

float phase(float period) {
    if (gMotionScale == 0.0f || period <= 0.0f) return 0.0f;
    requestFrames();
    const double scaledPeriod = static_cast<double>(period) * gMotionScale;
    return static_cast<float>(std::fmod(nowSeconds(), scaledPeriod) / scaledPeriod);
}

float pulse(float period) {
    if (gMotionScale == 0.0f || period <= 0.0f) return 1.0f;
    const float p = phase(period);
    constexpr float kTau = 6.28318530718f;
    return 0.5f - 0.5f * std::cos(kTau * p);
}

float stagger(double startedAt, std::size_t index, float duration) {
    if (gMotionScale == 0.0f || duration <= 0.0f) return 1.0f;
    const double delay = static_cast<double>(index) * kStagger * gMotionScale;
    const double elapsed = nowSeconds() - startedAt - delay;
    const float progress = clamp01(static_cast<float>(elapsed / (duration * gMotionScale)));
    if (progress < 1.0f) requestFrames();
    return easeOut(progress);
}

}  // namespace chud::anim
