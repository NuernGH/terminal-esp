//! Adapters that let a background worker (SSH, MQTT) look like a byte stream.

use std::io::{self, Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

pub type Chunk = io::Result<Vec<u8>>;

pub struct ChanReader {
    pub rx: Receiver<Chunk>,
    pub pending: Vec<u8>,
    pub poll: Duration,
}

impl Read for ChanReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv_timeout(self.poll) {
                Ok(Ok(v)) if v.is_empty() => return Err(io::ErrorKind::TimedOut.into()),
                Ok(Ok(v)) => self.pending = v,
                Ok(Err(e)) => return Err(e),
                Err(RecvTimeoutError::Timeout) => return Err(io::ErrorKind::TimedOut.into()),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = self.pending.len().min(buf.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

pub struct ChanWriter {
    pub send: Box<dyn FnMut(&[u8]) -> io::Result<()> + Send>,
}

impl Write for ChanWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        (self.send)(data)?;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
