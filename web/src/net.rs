//! The page's link to `pathlight web`: the scene is fetched once, frames arrive on one server-sent events stream, and acts go back as POSTs. The
//! per-run token from the page's address goes on every request. The view and selection are kept in the address, so a reload opens where it was.

use crate::data::{Frame, Message, Model};
use crate::{App, START};
use std::cell::RefCell;
use std::sync::Arc;
use wasm_bindgen::{JsCast, prelude::*};
use wasm_bindgen_futures::JsFuture;

thread_local! {
    static TOKEN: RefCell<String> = const { RefCell::new(String::new()) };
}

fn query(params: &web_sys::UrlSearchParams, key: &str) -> String {
    params.get(key).unwrap_or_default()
}

fn encode(s: &str) -> String {
    js_sys::encode_uri_component(s).as_string().unwrap_or_default()
}

fn token() -> String {
    TOKEN.with(|t| t.borrow().clone())
}

/// Sends the acts the page has queued, in order.
pub fn flush(s: &mut App) {
    let acts: Vec<String> = s.outbox.drain(..).map(|a| a.json()).collect();
    if acts.is_empty() || s.window.is_empty() {
        return;
    }
    let url = format!("/api/act?t={}&w={}", encode(&token()), encode(&s.window));
    wasm_bindgen_futures::spawn_local(async move {
        let Some(window) = web_sys::window() else { return };
        for body in acts {
            let init = web_sys::RequestInit::new();
            init.set_method("POST");
            init.set_body(&JsValue::from_str(&body));
            if let Ok(request) = web_sys::Request::new_with_str_and_init(&url, &init) {
                let _ = request.headers().set("content-type", "application/json");
                let _ = JsFuture::from(window.fetch_with_request(&request)).await;
            }
        }
    });
}

fn remember_in_address(frame: &Frame) {
    let Some(window) = web_sys::window() else { return };
    let mut url = format!("?t={}&view={}", encode(&token()), encode(&frame.view));
    if let Some(selected) = &frame.selected {
        url.push_str(&format!("&select={}", encode(selected)));
    }
    if let Ok(history) = window.history() {
        let _ = history.replace_state_with_url(&JsValue::NULL, "", Some(&url));
    }
}

async fn text_of(url: &str) -> Result<String, String> {
    let window = web_sys::window().ok_or("no window")?;
    let response: web_sys::Response = JsFuture::from(window.fetch_with_str(url)).await.map_err(|_| "pathlight web is not answering".to_string())?.dyn_into().map_err(|_| "not a response")?;
    if !response.ok() {
        return Err(format!("pathlight web answered {}", response.status()));
    }
    JsFuture::from(response.text().map_err(|_| "no body")?).await.ok().and_then(|v| v.as_string()).ok_or_else(|| "no body".into())
}

#[wasm_bindgen(start)]
pub fn start() {
    wasm_bindgen_futures::spawn_local(async {
        let window = web_sys::window().expect("a window");
        let params = web_sys::UrlSearchParams::new_with_str(&window.location().search().unwrap_or_default()).expect("the address parses");
        TOKEN.with(|t| *t.borrow_mut() = query(&params, "t"));
        let dark = window.match_media("(prefers-color-scheme: light)").ok().flatten().is_none_or(|m| !m.matches());
        let mode = if dark { "dark" } else { "light" };
        let (model, problem) = match text_of(&format!("/api/scene?t={}&mode={mode}", encode(&token()))).await.and_then(|json| Model::parse(&json)) {
            Ok(model) => (model, None),
            Err(e) => (Model::parse(r#"{"project":"","palette":{},"views":[]}"#).expect("empty"), Some(format!("Could not load the map: {e}"))),
        };
        let _ = START.set((Arc::new(model), Frame::default()));
        let app = rune::App::new(crate::spec());
        let handle = app.handle();
        if let Some(problem) = problem {
            handle.update(move |s: &mut App, _tx| s.problem = Some(problem.clone()));
        }
        let mut url = format!("/api/events?t={}&mode={mode}", encode(&token()));
        for key in ["view", "select"] {
            let value = query(&params, key);
            if !value.is_empty() {
                url.push_str(&format!("&{key}={}", encode(&value)));
            }
        }
        if let Ok(events) = web_sys::EventSource::new(&url) {
            let on_frame = handle.clone();
            let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
                let Some(json) = e.data().as_string() else { return };
                let Ok(message) = serde_json::from_str::<Message>(&json) else { return };
                remember_in_address(&message.frame);
                on_frame.update(move |s: &mut App, _tx| {
                    s.problem = None;
                    s.take(message.window.clone(), message.frame.clone());
                    flush(s);
                });
            });
            events.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
            on_message.forget();
            let on_lost = handle.clone();
            let on_error = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
                on_lost.update(|s: &mut App, _tx| s.problem = Some("Lost pathlight web. Run it again to reopen this map.".into()));
            });
            events.set_onerror(Some(on_error.as_ref().unchecked_ref()));
            on_error.forget();
            std::mem::forget(events);
        }
        app.run();
    });
}
