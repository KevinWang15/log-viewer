import React from "react";

export default class SectionIndicator extends React.PureComponent {
  render() {
    return <div className={"section-indicator"}>
      {this.props.text}
    </div>
  }
}