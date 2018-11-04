import React from "react";
import _ from "lodash";

export default class FilterBar extends React.PureComponent {
  debouncedOnChange = _.debounce(this.props.onChange, 500, {trailing: true});

  render() {
    return <div className={"search-bar"}>
      <input type="text"
             onChange={event => this.debouncedOnChange(event.target.value)}
             placeholder={"Filter logs.. (Supported syntax: containAny +mustContain -mustNotContain \"with whitespaces\")"}/>
    </div>
  }
}