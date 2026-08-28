#include "protocol/desktop_client.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

#include "protocol/json_codec.h"

namespace chud {

DesktopClient::DesktopClient(ITransport& transport, DesktopStore& store)
    : transport_(transport), store_(store), ownerThread_(std::this_thread::get_id()) {}

void DesktopClient::requireOwnerThread() const {
    if(std::this_thread::get_id()!=ownerThread_)throw std::logic_error("DesktopClient must be used from its owning GL thread");
}
void DesktopClient::start(){requireOwnerThread();transport_.start();}
void DesktopClient::stop(){requireOwnerThread();transport_.stop();}
void DesktopClient::setEventHandler(EventCallback callback){requireOwnerThread();eventCallback_=std::move(callback);}

void DesktopClient::reportError(std::string code,std::string message,std::optional<std::string> sessionPath) {
    store_.apply(EventFrame{{ErrorEvent{std::move(sessionPath),std::move(code),std::move(message)}}});
}

RequestId DesktopClient::request(std::string method, Json params, ResponseCallback callback, std::chrono::milliseconds timeout) {
    requireOwnerThread();
    if(!json_codec::isSupportedMethod(method))throw std::invalid_argument("unsupported desktop method: "+method);
    if(!params.is_object())throw std::invalid_argument("desktop request params must be an object");
    if(timeout<=std::chrono::milliseconds::zero())throw std::invalid_argument("desktop request timeout must be positive");
    if(nextRequestId_==0||nextRequestId_==std::numeric_limits<RequestId>::max())throw std::overflow_error("desktop request id space exhausted");
    const RequestId id=nextRequestId_++;
    Pending pending{method,params,Clock::now()+timeout,std::move(callback)};
    const auto encoded=json_codec::encodeFrame(RequestFrame{id,method,params});
    if(!transport_.sendText(encoded)) {
        ResponseFrame failure{id,method,std::nullopt,ResponseError{"transport-backpressure","request was not queued because the transport is disconnected or backpressured"}};
        reportError(failure.error->code,failure.error->message);
        if(pending.callback)pending.callback(failure);
        return id;
    }
    pending_.emplace(id,std::move(pending));
    return id;
}

void DesktopClient::handleResponse(ResponseFrame response) {
    const auto it=pending_.find(response.id);
    if(it==pending_.end()) { reportError("unexpected-response","response id has no pending request: "+std::to_string(response.id));return; }
    Pending pending=std::move(it->second);pending_.erase(it);
    if(response.method!=pending.method) {
        response.result.reset();response.error=ResponseError{"response-method-mismatch","expected "+pending.method+", received "+response.method};reportError(response.error->code,response.error->message);
    } else if(response.result) {
        try { store_.applyResponse(pending.method,pending.params,*response.result); }
        catch(const std::exception& e) { response.result.reset();response.error=ResponseError{"invalid-response",e.what()};reportError(response.error->code,response.error->message); }
    }
    if(pending.callback)pending.callback(response);
}

void DesktopClient::drain(Clock::time_point now) {
    requireOwnerThread();
    for(auto& raw:transport_.drainRaw()) {
        try {
            auto frame=json_codec::parseFrame(raw);
            if(auto* response=std::get_if<ResponseFrame>(&frame))handleResponse(std::move(*response));
            else if(auto* event=std::get_if<EventFrame>(&frame)) { store_.apply(*event);if(eventCallback_)eventCallback_(*event); }
            else reportError("unexpected-request","server sent a request frame to the desktop client");
        } catch(const std::exception& e) { reportError("invalid-frame",e.what()); }
    }
    std::vector<RequestId> expired;
    expired.reserve(pending_.size());
    for(const auto& [id,pending]:pending_)if(pending.deadline<=now)expired.push_back(id);
    std::sort(expired.begin(),expired.end());
    for(const auto id:expired) {
        const auto it=pending_.find(id);if(it==pending_.end())continue;
        Pending pending=std::move(it->second);pending_.erase(it);
        ResponseFrame timeout{id,pending.method,std::nullopt,ResponseError{"timeout","desktop request timed out"}};
        reportError(timeout.error->code,timeout.error->message);
        if(pending.callback)pending.callback(timeout);
    }
}

} // namespace chud
