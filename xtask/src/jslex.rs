//! A fail-closed JS comment stripper for the shim lint (plan §4.2).
//!
//! The stripped text is exactly what a JS engine sees as non-comment code, or the source is
//! rejected. The lexer never guesses whether `/` starts a regular expression: a `/` that is not a
//! comment opener and not provably division is an error ([`LexError::AmbiguousSlash`]).

/// Why a JS source was rejected. Lines are 1-based.
#[derive(Debug, PartialEq, Eq)]
pub enum LexError {
    UnterminatedBlockComment {
        line: u32,
    },
    UnterminatedString {
        line: u32,
    },
    UnterminatedTemplate {
        line: u32,
    },
    /// `/` not a comment opener and not provably division.
    AmbiguousSlash {
        line: u32,
    },
    /// U+2028, U+2029, or `\r` not followed by `\n`, anywhere in the file.
    LineTerminator {
        line: u32,
    },
    /// `<!--` or `-->` in code, or `#!` at offset 0.
    UnsupportedComment {
        line: u32,
    },
    /// `\` or a non-ASCII char in code (escaped identifiers, Unicode spaces).
    UnsupportedChar {
        line: u32,
    },
    /// `)` with no open `(`.
    UnbalancedParen {
        line: u32,
    },
}

/// Reserved words and contextual keywords after which `/` is never division.
pub const KEYWORDS: [&str; 50] = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "let",
    "static",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "await",
    "async",
    "of",
    "get",
    "set",
];

/// The last significant code token.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Prev {
    Start,
    Word(String),
    Number,
    CloseBracket,
    CloseParen { control: bool },
    Other,
}

#[derive(Debug, Clone, Copy)]
enum Frame {
    /// Code; `subst` when inside a template `${…}`, `depth` = open `{`.
    Code { subst: bool, depth: u32 },
    /// A template literal opened on `line`.
    Template { line: u32 },
}

fn is_word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$' || c == '#'
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#'
}

fn is_keyword(w: &str) -> bool {
    KEYWORDS.contains(&w)
}

#[derive(Debug)]
struct Lexer {
    chars: Vec<char>,
    i: usize,
    line: u32,
    out: String,
    frames: Vec<Frame>,
    parens: Vec<bool>,
    prev: Prev,
    /// A newline was seen in code whitespace or a comment since the last significant token.
    nl: bool,
}

impl Lexer {
    fn peek(&self, k: usize) -> Option<char> {
        self.chars.get(self.i + k).copied()
    }

    fn starts_with(&self, s: &str) -> bool {
        s.chars().enumerate().all(|(k, c)| self.peek(k) == Some(c))
    }

    /// Copies the current char to the output and advances.
    fn keep(&mut self) {
        if let Some(c) = self.peek(0) {
            if c == '\n' {
                self.line += 1;
            }
            self.out.push(c);
            self.i += 1;
        }
    }

    /// Replaces the current char with a space (line breaks are kept) and advances.
    fn blank(&mut self) {
        match self.peek(0) {
            Some('\n') => {
                self.nl = true;
                self.keep();
            }
            Some('\r') => self.keep(),
            Some(_) => {
                self.out.push(' ');
                self.i += 1;
            }
            None => {}
        }
    }

    fn significant(&mut self, prev: Prev) {
        self.prev = prev;
        self.nl = false;
    }

    fn run(mut self) -> Result<String, LexError> {
        while self.i < self.chars.len() {
            match self.frames.last() {
                Some(Frame::Template { .. }) => self.template(),
                _ => self.code()?,
            }
        }
        let open_template = self.frames.iter().rev().find_map(|f| match f {
            Frame::Template { line } => Some(*line),
            Frame::Code { .. } => None,
        });
        match open_template {
            Some(line) => Err(LexError::UnterminatedTemplate { line }),
            None => Ok(self.out),
        }
    }

    fn template(&mut self) {
        match self.peek(0) {
            Some('\\') => {
                self.keep();
                self.keep();
            }
            Some('$') if self.peek(1) == Some('{') => {
                self.keep();
                self.keep();
                self.frames.push(Frame::Code {
                    subst: true,
                    depth: 0,
                });
                self.significant(Prev::Start);
            }
            Some('`') => {
                self.keep();
                self.frames.pop();
                self.significant(Prev::Other);
            }
            _ => self.keep(),
        }
    }

    fn line_comment(&mut self) {
        while let Some(c) = self.peek(0) {
            if c == '\n' || c == '\r' {
                break;
            }
            self.blank();
        }
    }

    fn block_comment(&mut self, line: u32) -> Result<(), LexError> {
        self.blank();
        self.blank();
        loop {
            if self.starts_with("*/") {
                self.blank();
                self.blank();
                return Ok(());
            }
            if self.peek(0).is_none() {
                return Err(LexError::UnterminatedBlockComment { line });
            }
            self.blank();
        }
    }

    fn string(&mut self, quote: char, line: u32) -> Result<(), LexError> {
        self.keep();
        loop {
            match self.peek(0) {
                None | Some('\n') | Some('\r') => {
                    return Err(LexError::UnterminatedString { line });
                }
                Some('\\') => {
                    self.keep();
                    if self.peek(0) == Some('\r') && self.peek(1) == Some('\n') {
                        self.keep();
                    }
                    if self.peek(0).is_none() {
                        return Err(LexError::UnterminatedString { line });
                    }
                    self.keep();
                }
                Some(q) if q == quote => {
                    self.keep();
                    self.significant(Prev::Other);
                    return Ok(());
                }
                Some(_) => self.keep(),
            }
        }
    }

    fn slash_is_division(&self) -> bool {
        !self.nl
            && match &self.prev {
                Prev::Word(w) => !is_keyword(w),
                Prev::Number | Prev::CloseBracket => true,
                Prev::CloseParen { control } => !control,
                Prev::Start | Prev::Other => false,
            }
    }

    fn code(&mut self) -> Result<(), LexError> {
        let line = self.line;
        let Some(c) = self.peek(0) else {
            return Ok(());
        };
        if (self.i == 0 && self.starts_with("#!"))
            || self.starts_with("<!--")
            || self.starts_with("-->")
        {
            return Err(LexError::UnsupportedComment { line });
        }
        match c {
            '/' if self.peek(1) == Some('/') => self.line_comment(),
            '/' if self.peek(1) == Some('*') => self.block_comment(line)?,
            '/' => {
                if !self.slash_is_division() {
                    return Err(LexError::AmbiguousSlash { line });
                }
                self.keep();
                self.significant(Prev::Other);
            }
            '\'' | '"' => self.string(c, line)?,
            '`' => {
                self.keep();
                self.nl = false;
                self.frames.push(Frame::Template { line });
            }
            '(' => {
                let control = matches!(&self.prev, Prev::Word(w) if is_keyword(w));
                self.parens.push(control);
                self.keep();
                self.significant(Prev::Other);
            }
            ')' => {
                let Some(control) = self.parens.pop() else {
                    return Err(LexError::UnbalancedParen { line });
                };
                self.keep();
                self.significant(Prev::CloseParen { control });
            }
            ']' => {
                self.keep();
                self.significant(Prev::CloseBracket);
            }
            '{' => {
                if let Some(Frame::Code { depth, .. }) = self.frames.last_mut() {
                    *depth += 1;
                }
                self.keep();
                self.significant(Prev::Other);
            }
            '}' => {
                match self.frames.last_mut() {
                    Some(Frame::Code {
                        subst: true,
                        depth: 0,
                    }) => {
                        self.frames.pop();
                    }
                    Some(Frame::Code { depth, .. }) => *depth = depth.saturating_sub(1),
                    _ => {}
                }
                self.keep();
                self.significant(Prev::Other);
            }
            c if is_word_start(c) => {
                let mut w = String::new();
                while let Some(c) = self.peek(0).filter(|&c| is_word_char(c)) {
                    w.push(c);
                    self.keep();
                }
                self.significant(Prev::Word(w));
            }
            c if c.is_ascii_digit()
                || (c == '.' && self.peek(1).is_some_and(|d| d.is_ascii_digit())) =>
            {
                while self
                    .peek(0)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                {
                    self.keep();
                }
                self.significant(Prev::Number);
            }
            '\\' => return Err(LexError::UnsupportedChar { line }),
            c if !c.is_ascii() => return Err(LexError::UnsupportedChar { line }),
            '\n' => {
                self.nl = true;
                self.keep();
            }
            ' ' | '\t' | '\u{0B}' | '\u{0C}' | '\r' => self.keep(),
            _ => {
                self.keep();
                self.significant(Prev::Other);
            }
        }
        Ok(())
    }
}

/// Replaces every comment with spaces (newlines kept; strings and templates kept verbatim).
pub fn strip_comments(src: &str) -> Result<String, LexError> {
    let chars: Vec<char> = src.chars().collect();
    let mut line = 1u32;
    for (k, &c) in chars.iter().enumerate() {
        let lone_cr = c == '\r' && chars.get(k + 1) != Some(&'\n');
        if c == '\u{2028}' || c == '\u{2029}' || lone_cr {
            return Err(LexError::LineTerminator { line });
        }
        if c == '\n' {
            line += 1;
        }
    }
    Lexer {
        chars,
        i: 0,
        line: 1,
        out: String::with_capacity(src.len()),
        frames: vec![Frame::Code {
            subst: false,
            depth: 0,
        }],
        parens: Vec::new(),
        prev: Prev::Start,
        nl: false,
    }
    .run()
}

/// Number of lines with any non-whitespace character.
pub fn count_code_lines(stripped: &str) -> u32 {
    let n = stripped
        .lines()
        .filter(|l| l.chars().any(|c| !c.is_whitespace()))
        .count();
    u32::try_from(n).unwrap_or(u32::MAX)
}
