#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace chud::app {

struct AppOptions {
    std::string url;
    std::string token;
    std::string projectPath;
    std::optional<std::string> screenshotPath;
    int width = 1440;
    int height = 900;
    std::uint64_t frameLimit = 0;
    bool reducedMotion = false;
    bool accessibleLists = false;
};

class UsageError final : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[nodiscard]] AppOptions parseOptions(int argc, const char* const* argv);
[[nodiscard]] const char* usage() noexcept;
[[nodiscard]] int run(const AppOptions& options);

}  // namespace chud::app
