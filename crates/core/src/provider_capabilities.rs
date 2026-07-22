use std::process::Command;

pub fn help_advertises_bare(help: &str) -> bool {
    help.split_whitespace().any(|token| {
        token.trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '-')
            == "--bare"
    })
}

pub fn executable_supports_bare(program: &str) -> bool {
    Command::new(program)
        .arg("--help")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            let mut help = String::from_utf8_lossy(&output.stdout).into_owned();
            help.push_str(&String::from_utf8_lossy(&output.stderr));
            help_advertises_bare(&help)
        })
        .unwrap_or(false)
}

pub fn add_bare_when_supported(args: &mut Vec<String>, program: &str) {
    if executable_supports_bare(program) {
        args.push("--bare".to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_capability_requires_an_explicit_long_option() {
        assert!(help_advertises_bare(
            "Usage: agent [OPTIONS]\n  --bare  Start without extras"
        ));
        assert!(!help_advertises_bare("bare startup mode"));
        assert!(!help_advertises_bare("--barely-there"));
    }
}
