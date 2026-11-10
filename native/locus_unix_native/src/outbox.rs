//! Outbound frames of one broker connection.
//!
//! Same contract as the Windows `outbox`: replies are never dropped (a client
//! that falls more than [`REPLY_BYTE_LIMIT`] behind is disconnected so its
//! requests fail and it reconnects), while broadcast events keep only the latest
//! [`EVENT_FRAME_LIMIT`] and replace the oldest event of the same type first.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::Notify;

use crate::broker::now_ms;

pub(crate) const EVENT_FRAME_LIMIT: usize = 64;
pub(crate) const EVENT_BYTE_LIMIT: usize = 8 * 1024 * 1024;
#[cfg(not(test))]
pub(crate) const REPLY_BYTE_LIMIT: usize = 256 * 1024 * 1024;
#[cfg(test)]
pub(crate) const REPLY_BYTE_LIMIT: usize = 1024 * 1024;

enum Class {
    Reply,
    Event(String),
}

struct Frame {
    class: Class,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct State {
    frames: VecDeque<Frame>,
    reply_bytes: usize,
    event_bytes: usize,
    events: usize,
    closed: bool,
    superseded_total: u64,
    write_started_ms: i64,
}

impl State {
    fn remove(&mut self, index: usize) {
        if let Some(frame) = self.frames.remove(index) {
            match frame.class {
                Class::Reply => self.reply_bytes -= frame.bytes.len(),
                Class::Event(_) => {
                    self.event_bytes -= frame.bytes.len();
                    self.events -= 1;
                }
            }
        }
    }

    /// Oldest queued event of `kind`, else the oldest event at all.
    fn superseded_event(&self, kind: &str) -> Option<usize> {
        let same = self
            .frames
            .iter()
            .position(|frame| matches!(&frame.class, Class::Event(event) if event == kind));
        same.or_else(|| {
            self.frames
                .iter()
                .position(|frame| matches!(frame.class, Class::Event(_)))
        })
    }
}

pub(crate) struct Outbox {
    state: Mutex<State>,
    /// Wakes the writer when a frame is queued. `notify_one` is correct because
    /// exactly one writer drains the queue.
    frame_ready: Notify,
    /// Wakes readers of `closed()`. Kept separate from `frame_ready`: sharing
    /// one `Notify` lets a frame wake a `closed()` waiter (which then re-awaits
    /// and swallows the wakeup), leaving the frame queued forever.
    closed_notify: Notify,
    closed: AtomicBool,
}

impl Outbox {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            frame_ready: Notify::new(),
            closed_notify: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Queue one reply. `false` means the client is too far behind and the
    /// connection must be closed; the bytes stay queued for the last attempt.
    pub(crate) fn push_reply(&self, bytes: Vec<u8>) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return true,
        };
        state.reply_bytes += bytes.len();
        state.frames.push_back(Frame {
            class: Class::Reply,
            bytes,
        });
        drop(state);
        self.frame_ready.notify_one();
        let behind = self.state.lock().map(|state| state.reply_bytes).unwrap_or(0);
        behind <= REPLY_BYTE_LIMIT
    }

    /// Queue one broadcast event, replacing a superseded event when full.
    pub(crate) fn push_event(&self, kind: &str, bytes: Vec<u8>) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.event_bytes += bytes.len();
        state.events += 1;
        state.frames.push_back(Frame {
            class: Class::Event(kind.to_string()),
            bytes,
        });
        while state.events > EVENT_FRAME_LIMIT || (state.events > 1 && state.event_bytes > EVENT_BYTE_LIMIT) {
            let Some(index) = state.superseded_event(kind) else {
                break;
            };
            state.remove(index);
            state.superseded_total += 1;
        }
        drop(state);
        self.frame_ready.notify_one();
    }

    /// Block until a frame is queued (or the outbox closes).
    ///
    /// The `notified()` future is created *before* the queue is inspected: a
    /// producer that notifies between the check and the await would otherwise
    /// be lost and the writer would sleep until the next frame.
    pub(crate) async fn next(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.frame_ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Ok(mut state) = self.state.lock() {
                if let Some(frame) = state.frames.pop_front() {
                    match frame.class {
                        Class::Reply => state.reply_bytes -= frame.bytes.len(),
                        Class::Event(_) => {
                            state.event_bytes -= frame.bytes.len();
                            state.events -= 1;
                        }
                    }
                    state.write_started_ms = now_ms();
                    return Some(frame.bytes);
                }
            }
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            notified.as_mut().await;
        }
    }

    /// The frame taken by [`next`] has been written.
    pub(crate) fn written(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.write_started_ms = 0;
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.frame_ready.notify_waiters();
        self.closed_notify.notify_waiters();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub(crate) async fn closed(&self) {
        loop {
            let notified = self.closed_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_closed() {
                return;
            }
            notified.as_mut().await;
        }
    }

    pub(crate) fn status_json(&self, now: i64) -> serde_json::Value {
        let Ok(state) = self.state.lock() else {
            return serde_json::Value::Null;
        };
        serde_json::json!({
            "queuedReplies": state.frames.iter().filter(|frame| matches!(frame.class, Class::Reply)).count(),
            "queuedEvents": state.events,
            "replyBytes": state.reply_bytes,
            "eventBytes": state.event_bytes,
            "supersededEvents": state.superseded_total,
            "writingMs": if state.write_started_ms > 0 { now.saturating_sub(state.write_started_ms) } else { 0 },
            "closed": state.closed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn events_are_bounded_and_replies_are_not() {
        let outbox = Outbox::new();
        for index in 0..(EVENT_FRAME_LIMIT + 10) {
            outbox.push_event("status", format!("e{index}\n").into_bytes());
        }
        for index in 0..3 {
            assert!(outbox.push_reply(format!("r{index}\n").into_bytes()));
        }
        let mut seen = Vec::new();
        while let Some(bytes) = outbox.next().await {
            seen.push(String::from_utf8(bytes).unwrap());
            outbox.written();
            if seen.len() >= EVENT_FRAME_LIMIT + 3 {
                break;
            }
        }
        assert!(seen.iter().filter(|line| line.starts_with('r')).count() == 3);
        assert!(seen.len() <= EVENT_FRAME_LIMIT + 3);
    }
}
