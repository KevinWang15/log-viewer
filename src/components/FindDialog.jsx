import React from "react";
import _ from "lodash";

export default class FindDialog extends React.PureComponent {
  debouncedOnChange = _.debounce(this.props.onChange, 200, {trailing: true, maxWait: 500});
  onKeyPress = event => {
    if (event.key === "Enter") {
      if (event.shiftKey) {
        this.props.findPrev();
      } else {
        this.props.findNext();
      }
    }
  };

  render() {
    return <div className={"find-dialog"}>
      <input type="text"
             onChange={event => this.debouncedOnChange(event.target.value)}
             placeholder={"Keyword (regex enabled, press Enter / Shift Enter to search, Esc to close)"}
             id="search-box"
             onKeyPress={this.onKeyPress}
      />
      {(!!this.props.value) && <div className="indicator">
        {this.props.at + 1} {"/"} {this.props.count}
      </div>}
    </div>
  }
}