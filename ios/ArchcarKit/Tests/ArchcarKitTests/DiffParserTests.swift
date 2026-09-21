import Testing

@testable import ArchcarKit

@Test func classifiesDiffLines() {
    let diff = """
    diff --git a/src/main.rs b/src/main.rs
    index 1234567..89abcde 100644
    --- a/src/main.rs
    +++ b/src/main.rs
    @@ -1,4 +1,5 @@
     fn main() {
    -    println!("old");
    +    println!("new");
    +    println!("extra");
     }
    """
    let parsed = DiffParser.parse(diff)
    #expect(parsed.truncated == false)
    let kinds = parsed.lines.map(\.kind)
    #expect(kinds.prefix(4).allSatisfy { $0 == .fileHeader })
    #expect(kinds[4] == .hunkHeader)
    #expect(kinds.filter { $0 == .addition }.count == 2)
    #expect(kinds.filter { $0 == .deletion }.count == 1)
    #expect(kinds.filter { $0 == .context }.count == 2)
}

@Test func truncatesEnormousDiffs() {
    // A lockfile diff is megabytes; a phone shows the top rather than stalling.
    let diff = (0..<(DiffParser.lineLimit + 500)).map { "+line \($0)" }.joined(separator: "\n")
    let parsed = DiffParser.parse(diff)
    #expect(parsed.truncated)
    #expect(parsed.lines.count == DiffParser.lineLimit)
}

@Test func treatsMinusMinusMinusAsHeaderNotDeletion() {
    // `--- a/file` starts with a minus but is a header; colouring it red as a
    // deleted line is the classic unified-diff rendering bug.
    let parsed = DiffParser.parse("--- a/file\n-real deletion")
    #expect(parsed.lines[0].kind == .fileHeader)
    #expect(parsed.lines[1].kind == .deletion)
}
