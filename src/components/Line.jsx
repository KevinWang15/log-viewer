import React from "react";

export default class Line extends React.PureComponent {
  render() {
    const line = this.props.line;
    let className = "line";
    if (line.trim().startsWith("at") || line.trim().startsWith("...")) {
      className += " unimportant";
    } else if (line.trim().startsWith(">>>>> ")) {
      className += " new-section";
    } else if (line.trim().startsWith("<<<<<")) {
      className += " end-of-section";
    }
    let content = line;
    if (this.props.highlightRange) {
      content = [];
      content.push(line.substr(0, this.props.highlightRange[0]));
      content.push(<span
        className={"highlighted"}
        key="hl">{line.substr(this.props.highlightRange[0], this.props.highlightRange[1])}</span>);
      content.push(line.substr(this.props.highlightRange[0] + this.props.highlightRange[1]));
    }
    // TODO: The performance is just terrible..
    // if (this.props.search) {
    //   content = [];
    //
    //   let re = new RegExp(this.props.search, "gi");
    //   let match;
    //   let pointer = 0;
    //
    //   do {
    //     match = re.exec(line);
    //     if (match) {
    //       content.push(line.substr(pointer, match.index));
    //       content.push(<span className="highlighted">{match[0]}</span>);
    //       pointer = match.index + match[0].length;
    //     }
    //   } while (match);
    //
    //   content.push(line.substr(pointer));
    // }
    return <div className={className} tabIndex={this.props.index} data-index={this.props.index}>{content}</div>

  }
}
