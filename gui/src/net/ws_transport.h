#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace chud {

struct TransportBootstrap {
    std::string url;
    std::string host;
    std::string token;

    static TransportBootstrap fromProcess(int argc, const char* const* argv);
};

struct WsTransportConfig {
    std::string url;
    std::string token;
    std::size_t incomingCapacity = 1024;
    std::size_t maxBufferedAmount = 1U << 20;
    std::uint32_t reconnectMinSeconds = 1;
    std::uint32_t reconnectMaxSeconds = 30;
    int pingIntervalSeconds = 20;
};

class BoundedRawFifo {
public:
    explicit BoundedRawFifo(std::size_t capacity);
    void push(std::string value);
    std::vector<std::string> drain();
    std::size_t size() const noexcept;
    std::size_t dropped() const noexcept;

private:
    const std::size_t capacity_;
    mutable std::mutex mutex_;
    std::deque<std::string> values_;
    std::size_t dropped_ = 0;
};

class ITransport {
public:
    virtual ~ITransport() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual bool sendText(std::string_view text) = 0;
    virtual std::vector<std::string> drainRaw() = 0;
    virtual bool connected() const noexcept = 0;
    virtual std::size_t droppedIncoming() const noexcept = 0;
};

class WsTransport final : public ITransport {
public:
    explicit WsTransport(WsTransportConfig config);
    ~WsTransport() override;
    WsTransport(const WsTransport&) = delete;
    WsTransport& operator=(const WsTransport&) = delete;

    void start() override;
    void stop() override;
    bool sendText(std::string_view text) override;
    std::vector<std::string> drainRaw() override;
    bool connected() const noexcept override;
    std::size_t droppedIncoming() const noexcept override;

    std::size_t queuedIncoming() const noexcept;
    static std::uint32_t reconnectDelaySeconds(std::uint32_t attempt, std::uint32_t minimum, std::uint32_t maximum) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace chud
