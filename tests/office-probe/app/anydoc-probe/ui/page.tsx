"use client";

import { useState } from "react";

import { ComposerShell } from "@/components/chat/composer/ComposerShell";
import { MessageEditor } from "@/components/chat/message/MessageEditor";
import type { Attachment } from "@/types/chat";

export default function AttachmentUiProbe() {
    const [result, setResult] = useState("");
    const report = (attachments?: Attachment[]) => setResult(JSON.stringify(attachments));
    return (
        <main>
            <section id="composer-probe">
                <ComposerShell
                    ready
                    busy={false}
                    visionBlocked
                    onSubmit={(_text, attachments) => report(attachments)}
                />
            </section>
            <section id="editor-probe">
                <MessageEditor
                    initial="test"
                    initialAttachments={[]}
                    visionBlocked
                    submitLabel="Save"
                    onCancel={() => {}}
                    onSubmit={(_text, attachments) => report(attachments)}
                />
            </section>
            <pre id="submitted">{result}</pre>
        </main>
    );
}
