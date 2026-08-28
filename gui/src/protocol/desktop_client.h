#pragma once

#include <chrono>
#include <cstddef>
#include <functional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>

#include "net/ws_transport.h"
#include "protocol/desktop_store.h"

namespace chud {

class DesktopClient {
public:
    using Clock = std::chrono::steady_clock;
    using ResponseCallback = std::function<void(const ResponseFrame&)>;
    using EventCallback = std::function<void(const EventFrame&)>;

    DesktopClient(ITransport& transport, DesktopStore& store);
    ~DesktopClient() = default;
    DesktopClient(const DesktopClient&) = delete;
    DesktopClient& operator=(const DesktopClient&) = delete;

    void start();
    void stop();
    RequestId request(std::string method, Json params, ResponseCallback callback = {},
        std::chrono::milliseconds timeout = std::chrono::seconds(10));
    void drain(Clock::time_point now = Clock::now());
    void setEventHandler(EventCallback callback);

    std::size_t pendingCount() const noexcept { return pending_.size(); }
    RequestId nextRequestId() const noexcept { return nextRequestId_; }

private:
    struct Pending {
        std::string method;
        Json params;
        Clock::time_point deadline;
        ResponseCallback callback;
    };

    void requireOwnerThread() const;
    void reportError(std::string code, std::string message, std::optional<std::string> sessionPath = std::nullopt);
    void handleResponse(ResponseFrame response);

    ITransport& transport_;
    DesktopStore& store_;
    std::thread::id ownerThread_;
    RequestId nextRequestId_ = 1;
    std::unordered_map<RequestId, Pending> pending_;
    EventCallback eventCallback_;
};

} // namespace chud
