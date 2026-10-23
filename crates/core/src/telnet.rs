//! Minimal Telnet layer: strips IAC command sequences from incoming data and
//! refuses every option the peer proposes, so a Telnet-style serial bridge
//! behaves like a plain byte stream.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

/// What to announce to the server: terminal type and window size.
#[derive(Clone)]
pub struct TermOpts {
    pub term: String,
    /// Window size as `cols << 16 | rows`, kept current by the UI.
    pub size: Arc<AtomicU32>,
    /// Set once the server asked for window size reports.
    pub naws: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct TelnetFilter {
    state: State,
    opts: Option<TermOpts>,
    sub: Vec<u8>,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum State {
    #[default]
    Data,
    Iac,
    Option(u8),
    Sub,
    SubIac,
}

/// `IAC SB NAWS cols rows IAC SE`, with 255 bytes doubled.
pub fn naws_bytes(cols: u16, rows: u16) -> Vec<u8> {
    let mut v = vec![IAC, SB, NAWS];
    for b in [(cols >> 8) as u8, cols as u8, (rows >> 8) as u8, rows as u8] {
        v.push(b);
        if b == IAC {
            v.push(IAC);
        }
    }
    v.extend_from_slice(&[IAC, SE]);
    v
}

impl TelnetFilter {
    pub fn with_terminal(opts: TermOpts) -> Self {
        TelnetFilter { opts: Some(opts), ..Default::default() }
    }

    fn option(&mut self, cmd: u8, opt: u8, reply: &mut Vec<u8>) {
        let Some(o) = self.opts.clone() else {
            match cmd {
                DO => reply.extend_from_slice(&[IAC, WONT, opt]),
                WILL => reply.extend_from_slice(&[IAC, DONT, opt]),
                _ => {}
            }
            return;
        };
        match (cmd, opt) {
            (DO, TTYPE) => reply.extend_from_slice(&[IAC, WILL, TTYPE]),
            (DO, NAWS) => {
                reply.extend_from_slice(&[IAC, WILL, NAWS]);
                let sz = o.size.load(Ordering::Relaxed);
                reply.extend(naws_bytes((sz >> 16) as u16, sz as u16));
                o.naws.store(true, Ordering::Relaxed);
            }
            (DO, SGA) => reply.extend_from_slice(&[IAC, WILL, SGA]),
            (WILL, ECHO | SGA) => reply.extend_from_slice(&[IAC, DO, opt]),
            (DO, _) => reply.extend_from_slice(&[IAC, WONT, opt]),
            (WILL, _) => reply.extend_from_slice(&[IAC, DONT, opt]),
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        // TERMINAL-TYPE SEND (1) is answered with TERMINAL-TYPE IS (0) <name>.
        if let (Some(o), [TTYPE, 1, ..]) = (&self.opts, self.sub.as_slice()) {
            reply.extend_from_slice(&[IAC, SB, TTYPE, 0]);
            reply.extend_from_slice(o.term.as_bytes());
            reply.extend_from_slice(&[IAC, SE]);
        }
        self.sub.clear();
    }

    /// Returns the payload bytes; any protocol replies are appended to `reply`.
    pub fn process(&mut self, input: &[u8], reply: &mut Vec<u8>) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        for &b in input {
            self.state = match self.state {
                State::Data => {
                    if b == IAC {
                        State::Iac
                    } else {
                        out.push(b);
                        State::Data
                    }
                }
                State::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        State::Data
                    }
                    DO | DONT | WILL | WONT => State::Option(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => State::Data,
                },
                State::Option(cmd) => {
                    self.option(cmd, b, reply);
                    State::Data
                }
                State::Sub => {
                    if b == IAC {
                        State::SubIac
                    } else {
                        if self.sub.len() < 64 {
                            self.sub.push(b);
                        }
                        State::Sub
                    }
                }
                State::SubIac => {
                    if b == SE {
                        self.subnegotiation(reply);
                        State::Data
                    } else {
                        State::Sub
                    }
                }
            };
        }
        out
    }

    /// Escapes outgoing 0xFF bytes.
    pub fn escape(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            out.push(b);
            if b == IAC {
                out.push(IAC);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_plain_text() {
        let mut f = TelnetFilter::default();
        let mut r = Vec::new();
        assert_eq!(f.process(b"hello", &mut r), b"hello");
        assert!(r.is_empty());
    }

    #[test]
    fn strips_negotiation_and_refuses_options() {
        let mut f = TelnetFilter::default();
        let mut r = Vec::new();
        let out = f.process(&[b'a', IAC, DO, 1, b'b', IAC, WILL, 3, b'c'], &mut r);
        assert_eq!(out, b"abc");
        assert_eq!(r, vec![IAC, WONT, 1, IAC, DONT, 3]);
    }

    #[test]
    fn handles_split_sequences_and_escaped_iac() {
        let mut f = TelnetFilter::default();
        let mut r = Vec::new();
        let mut out = f.process(&[b'x', IAC], &mut r);
        out.extend(f.process(&[IAC, b'y'], &mut r));
        assert_eq!(out, vec![b'x', IAC, b'y']);
    }

    #[test]
    fn skips_subnegotiation() {
        let mut f = TelnetFilter::default();
        let mut r = Vec::new();
        let out = f.process(&[IAC, SB, 24, 1, IAC, SE, b'z'], &mut r);
        assert_eq!(out, b"z");
    }

    #[test]
    fn escapes_outgoing_iac() {
        assert_eq!(TelnetFilter::escape(&[1, IAC, 2]), vec![1, IAC, IAC, 2]);
    }

    #[test]
    fn announces_terminal_type_and_window_size() {
        let opts = TermOpts { term: "VT100".into(), size: Arc::new(AtomicU32::new(100 << 16 | 30)), naws: Arc::new(AtomicBool::new(false)) };
        let mut f = TelnetFilter::with_terminal(opts.clone());
        let mut r = Vec::new();
        f.process(&[IAC, DO, TTYPE, IAC, DO, NAWS, IAC, WILL, ECHO, IAC, DO, 99], &mut r);
        let mut want = vec![IAC, WILL, TTYPE, IAC, WILL, NAWS];
        want.extend(naws_bytes(100, 30));
        want.extend_from_slice(&[IAC, DO, ECHO, IAC, WONT, 99]);
        assert_eq!(r, want);
        assert!(opts.naws.load(Ordering::Relaxed));
        let mut r = Vec::new();
        let out = f.process(&[IAC, SB, TTYPE, 1, IAC, SE, b'x'], &mut r);
        assert_eq!(out, b"x");
        assert_eq!(r, [&[IAC, SB, TTYPE, 0][..], b"VT100", &[IAC, SE]].concat());
    }

    #[test]
    fn naws_doubles_255() {
        assert_eq!(naws_bytes(255, 24), vec![IAC, SB, NAWS, 0, IAC, IAC, 0, 24, IAC, SE]);
    }
}
