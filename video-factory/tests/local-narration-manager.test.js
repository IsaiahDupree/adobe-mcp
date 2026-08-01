const test = require("node:test");
const assert = require("node:assert/strict");
const { captionCues } = require("../lib/local-narration-manager");

test("offline narration creates contiguous sentence caption timing", () => {
    const cues = captionCues("First sentence. A somewhat longer second sentence!", 6);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[1].end, 6);
    assert.equal(cues[0].end, cues[1].start);
    assert.ok(cues[1].end > cues[1].start);
});
