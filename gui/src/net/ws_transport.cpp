#include "net/ws_transport.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <utility>

#include <ixwebsocket/IXWebSocket.h>

namespace chud {
namespace {

std::string envValue(const char* name) {
    const char* value=std::getenv(name);
    return value == nullptr ? std::string{} : std::string(value);
}

void parseOption(int& i, int argc, const char* const* argv, std::string_view name, std::string& output) {
    const std::string_view arg(argv[i]);
    const std::string prefix=std::string(name)+"=";
    if(arg.starts_with(prefix)) { output=std::string(arg.substr(prefix.size())); return; }
    if(arg==name) {
        if(i+1>=argc) throw std::invalid_argument("missing value for "+std::string(name));
        output=argv[++i];
    }
}

bool isLoopbackUrl(std::string_view url) {
    const auto schemeEnd=url.find("://");
    if(schemeEnd==std::string_view::npos)return false;
    auto scheme=std::string(url.substr(0,schemeEnd));
    for(char& c:scheme)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if(scheme!="ws"&&scheme!="wss")return false;
    auto authority=url.substr(schemeEnd+3);
    authority=authority.substr(0,authority.find('/'));
    if(authority.empty()||authority.find('@')!=std::string_view::npos)return false;
    std::string_view host;
    if(authority.front()=='[') {
        const auto close=authority.find(']');
        if(close==std::string_view::npos)return false;
        host=authority.substr(1,close-1);
        if(close+1<authority.size()&&authority[close+1]!=':')return false;
    } else {
        host=authority.substr(0,authority.find(':'));
    }
    std::string normalized(host);
    for(char& c:normalized)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return normalized=="localhost"||normalized=="127.0.0.1"||normalized=="::1";
}

std::string originForUrl(std::string_view url) {
    const auto schemeEnd = url.find("://");
    const auto authorityStart = schemeEnd + 3;
    const auto pathStart = url.find('/', authorityStart);
    const std::string_view authority =
        pathStart == std::string_view::npos ? url.substr(authorityStart)
                                            : url.substr(authorityStart, pathStart - authorityStart);
    const std::string_view scheme = url.substr(0, schemeEnd);
    return std::string(scheme == "wss" ? "https://" : "http://") + std::string(authority);
}

} // namespace

TransportBootstrap TransportBootstrap::fromProcess(int argc, const char* const* argv) {
    TransportBootstrap result{envValue("CHUDCODE_DESKTOP_URL"),envValue("CHUDCODE_DESKTOP_HOST"),envValue("CHUDCODE_DESKTOP_TOKEN")};
    for(int i=1;i<argc;++i) {
        const std::string_view arg(argv[i]);
        if(arg=="--desktop-url"||arg.starts_with("--desktop-url="))parseOption(i,argc,argv,"--desktop-url",result.url);
        else if(arg=="--desktop-host"||arg.starts_with("--desktop-host="))parseOption(i,argc,argv,"--desktop-host",result.host);
        else if(arg=="--desktop-token"||arg.starts_with("--desktop-token="))parseOption(i,argc,argv,"--desktop-token",result.token);
    }
    if(result.url.empty()&&!result.host.empty()) {
        if(result.host.starts_with("ws://")||result.host.starts_with("wss://"))result.url=result.host;
        else result.url="ws://"+result.host;
    }
    return result;
}

BoundedRawFifo::BoundedRawFifo(std::size_t capacity) : capacity_(capacity) {
    if(capacity_==0)throw std::invalid_argument("FIFO capacity must be positive");
}
void BoundedRawFifo::push(std::string value) {
    std::scoped_lock lock(mutex_);
    if(values_.size()==capacity_){values_.pop_front();++dropped_;}
    values_.push_back(std::move(value));
}
std::vector<std::string> BoundedRawFifo::drain() {
    std::scoped_lock lock(mutex_);
    std::vector<std::string> output;
    output.reserve(values_.size());
    while(!values_.empty()){output.push_back(std::move(values_.front()));values_.pop_front();}
    return output;
}
std::size_t BoundedRawFifo::size()const noexcept{std::scoped_lock lock(mutex_);return values_.size();}
std::size_t BoundedRawFifo::dropped()const noexcept{std::scoped_lock lock(mutex_);return dropped_;}

struct WsTransport::Impl {
    explicit Impl(WsTransportConfig value) : config(std::move(value)), incoming(config.incomingCapacity) {}
    WsTransportConfig config;
    ix::WebSocket socket;
    BoundedRawFifo incoming;
    std::atomic<bool> connected{false};
    bool started=false;
};

WsTransport::WsTransport(WsTransportConfig config) : impl_(std::make_unique<Impl>(std::move(config))) {
    if(impl_->config.url.empty())throw std::invalid_argument("WebSocket URL is required");
    if(!isLoopbackUrl(impl_->config.url))throw std::invalid_argument("desktop WebSocket URL must target loopback");
    if(impl_->config.token.empty())throw std::invalid_argument("desktop bearer token is required");
    if(impl_->config.token.find_first_of("\r\n")!=std::string::npos)throw std::invalid_argument("desktop bearer token contains a line break");
    if(impl_->config.incomingCapacity==0)throw std::invalid_argument("incoming capacity must be positive");
    if(impl_->config.maxBufferedAmount==0)throw std::invalid_argument("buffered amount bound must be positive");
    if(impl_->config.reconnectMinSeconds==0||impl_->config.reconnectMaxSeconds<impl_->config.reconnectMinSeconds)throw std::invalid_argument("invalid reconnect bounds");
    if(impl_->config.pingIntervalSeconds<=0)throw std::invalid_argument("ping interval must be positive");

    impl_->socket.setUrl(impl_->config.url);
    impl_->socket.setExtraHeaders({
        {"Authorization", "Bearer " + impl_->config.token},
        {"Origin", originForUrl(impl_->config.url)},
    });
    impl_->socket.setPingInterval(impl_->config.pingIntervalSeconds);
    impl_->socket.enableAutomaticReconnection();
    impl_->socket.setMinWaitBetweenReconnectionRetries(impl_->config.reconnectMinSeconds);
    impl_->socket.setMaxWaitBetweenReconnectionRetries(impl_->config.reconnectMaxSeconds);
    impl_->socket.setOnMessageCallback([this](const ix::WebSocketMessagePtr& message) {
        if(message->type==ix::WebSocketMessageType::Open) { impl_->connected.store(true,std::memory_order_release); return; }
        if(message->type==ix::WebSocketMessageType::Close||message->type==ix::WebSocketMessageType::Error) { impl_->connected.store(false,std::memory_order_release); return; }
        if(message->type!=ix::WebSocketMessageType::Message||message->binary)return;
        impl_->incoming.push(message->str);
    });
}

WsTransport::~WsTransport(){stop();}
void WsTransport::start(){if(!impl_->started){impl_->started=true;impl_->socket.start();}}
void WsTransport::stop(){if(impl_&&impl_->started){impl_->socket.stop();impl_->started=false;impl_->connected.store(false,std::memory_order_release);}}
bool WsTransport::sendText(std::string_view text) {
    if(!connected())return false;
    const auto buffered=impl_->socket.bufferedAmount();
    if(buffered>impl_->config.maxBufferedAmount||text.size()>impl_->config.maxBufferedAmount-buffered)return false;
    return impl_->socket.sendText(std::string(text)).success;
}
std::vector<std::string> WsTransport::drainRaw(){return impl_->incoming.drain();}
bool WsTransport::connected()const noexcept{return impl_->connected.load(std::memory_order_acquire);}
std::size_t WsTransport::droppedIncoming()const noexcept{return impl_->incoming.dropped();}
std::size_t WsTransport::queuedIncoming()const noexcept{return impl_->incoming.size();}
std::uint32_t WsTransport::reconnectDelaySeconds(std::uint32_t attempt,std::uint32_t minimum,std::uint32_t maximum)noexcept {
    if(minimum==0)return 0;if(maximum<minimum)maximum=minimum;
    std::uint64_t delay=minimum;
    const auto shifts=std::min<std::uint32_t>(attempt,31);
    delay=std::min<std::uint64_t>(static_cast<std::uint64_t>(maximum),delay<<shifts);
    return static_cast<std::uint32_t>(delay);
}

} // namespace chud
