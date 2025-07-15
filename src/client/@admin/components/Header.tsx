import React from 'react';

const Header = () => {
  return (
    <div className="container__taujs">
      <a href="https://taujs.dev" target="_blank" title="taujs [ &tau;js ]" rel="noreferrer">
        <img src="/taujs.svg" className="logo &tau;js" alt="&tau;js logo" />
      </a>
      <h1 className="&tau;js">taujs [ &tau;js ]</h1>
      <h2>Micro-Frontend</h2>
    </div>
  );
};

export default Header;
