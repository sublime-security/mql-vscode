# Message Query Language (MQL) extension for Visual Studio Code

[Sublime](https://sublime.security) prevents email attacks using AI and Detection-as-Code. Gain visibility and control, hunt for advanced threats, and spend less time on email-originated incidents.

Use the Sublime Platform to:

- block email attacks such as phishing, BEC, and malware
- hunt for threats over email
- auto-triage user reports with phishing herd immunity and Triage rules


At its core, Sublime is a rules engine that ingests email messages from arbitrary sources, parsing to a structured **Message Data Model *(MDM)** which powers rules written in **Message Query Language (MQL)**. When rules match, actions are taken such as generating a webhook notification or inserting a warning banner. Emails are extracted Below is an example of a simple rule:

```yaml
name: HTML smuggling via attachment
severity: high
source: |
  type.inbound
  and any(attachments, .file_extension in~ ('html', 'htm') 
          and any(file.explode(.),
                  any(.scan.javascript.identifiers, . == "unescape")
          )
  )
tags:
  - "HTML smuggling"
```


The MQL extension for Visual Studio code provides validation and completion capabilities

- Syntax highlighting
- Autocompletion (if the Language Server is enabled)
- Validation of functions and types (if the Language Server is enabled)
- Diagnostic hints, warnings, and errors (if the Language Server is enabled)


## Resources

- [Sublime Security homepage](https://sublime.security)
- [Detection rules](https://github.com/sublime-security/detection-rules) on GitHub
- [Sublime Security Platform](https://platform.sublime.security)
- [Platform documentation](https://docs.sublime.security/docs)
	- [Message Data Model (MDM)](https://docs.sublime.security/docs/mdm)
	- [Message Query Language (MDM)](https://docs.sublime.security/docs/message-query-language)

<!-- Developers: See https://code.visualstudio.com/api/language-extensions/language-server-extension-guide for more details -->