//! Minimal Telnet layer: strips IAC command sequences from incoming data and
//! refuses every option the peer proposes, so a Telnet-style serial bridge
//! behaves like a plain byte stream.

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

#[derive(Default)]
pub struct TelnetFilter {
    state: State,
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

impl TelnetFilter {
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
                    SB => State::Sub,
                    _ => State::Data,
                },
                State::Option(cmd) => {
                    match cmd {
                        DO => reply.extend_from_slice(&[IAC, WONT, b]),
                        WILL => reply.extend_from_slice(&[IAC, DONT, b]),
                        _ => {}
                    }
                    State::Data
                }
                State::Sub => {
                    if b == IAC {
                        State::SubIac
                    } else {
                        State::Sub
                    }
                }
                State::SubIac => {
                    if b == SE {
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
}
